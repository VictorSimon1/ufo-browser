#include "native/cef-host/app.h"

#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <utility>

#include "include/cef_browser.h"
#include "include/cef_command_line.h"
#include "include/cef_parser.h"
#include "include/cef_request_context.h"
#include "include/cef_values.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_helpers.h"
#include "native/cef-host/handler.h"
#include "native/cef-host/overlay_mac.h"

namespace {

class UfoWindowDelegate final : public CefWindowDelegate {
 public:
  explicit UfoWindowDelegate(CefRefPtr<CefBrowserView> browser_view,
                             bool present_on_start = false,
                             bool show_shell_controls = false,
                             bool main_window = true,
                             int space_id = 0,
                             std::string space_name = {},
                             std::string profile_name = {},
                             std::string presentation_socket = {})
      : browser_view_(browser_view),
        present_on_start_(present_on_start),
        show_shell_controls_(show_shell_controls),
        main_window_(main_window),
        space_id_(space_id),
        space_name_(std::move(space_name)),
        profile_name_(std::move(profile_name)),
        presentation_socket_(std::move(presentation_socket)) {}

  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    window->AddChildView(browser_view_);
    if (auto* handler = UfoCefHandler::GetInstance()) {
      if (main_window_) handler->SetMainWindow(window);
      if (space_id_ > 0) handler->RegisterSpaceWindow(space_id_, window);
      if (space_id_ > 0 && browser_view_->GetBrowser()) {
        handler->RegisterBrowserSpace(browser_view_->GetBrowser(), space_id_);
      }
    }
    // Overview is the only surface that should appear on cold start. Space
    // runtimes are warm/background browser windows and are shown explicitly
    // by the Presentation Coordinator, avoiding a visible flash or focus
    // steal while an Agent is bootstrapping a Space.
    auto command_line = CefCommandLine::GetGlobalCommandLine();
    if (present_on_start_ || command_line->HasSwitch("overview") ||
        command_line->HasSwitch("show-on-start")) {
      window->Show();
      UfoCefWindowSetPresented(window->GetWindowHandle(), true);
    } else {
      // Do not Hide/orderOut a Space. CEF may stop producing compositor frames
      // for a fully hidden Views window, which makes Agent screenshots stall.
      window->Show();
      UfoCefWindowSetPresented(window->GetWindowHandle(), false);
    }
    if (show_shell_controls_ && !command_line->HasSwitch("overview")) {
      const auto presentation_socket = presentation_socket_.empty()
          ? command_line->GetSwitchValue("presentation-socket").ToString()
          : presentation_socket_;
      if (!presentation_socket.empty()) {
        UfoCefShellControlsSet(window->GetWindowHandle(), presentation_socket.c_str());
        const auto encoded_space_name = space_name_.empty()
            ? command_line->GetSwitchValue("space-name").ToString()
            : space_name_;
        const auto encoded_profile_name = profile_name_.empty()
            ? command_line->GetSwitchValue("profile-name").ToString()
            : profile_name_;
        const auto decode = [](const std::string& value) {
          std::string decoded;
          decoded.reserve(value.size());
          for (size_t i = 0; i < value.size(); ++i) {
            if (value[i] == '%' && i + 2 < value.size()) {
              const auto hex = [](char c) -> int {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                return -1;
              };
              const int hi = hex(value[i + 1]);
              const int lo = hex(value[i + 2]);
              if (hi >= 0 && lo >= 0) {
                decoded.push_back(static_cast<char>((hi << 4) | lo));
                i += 2;
                continue;
              }
            }
            decoded.push_back(value[i]);
          }
          return decoded;
        };
        const auto space_name = decode(encoded_space_name);
        const auto profile_name = decode(encoded_profile_name);
        window->SetTitle((std::string("UFO-Browser · ") +
                         (space_name.empty() ? "Space" : space_name)).c_str());
        UfoCefSpaceControllerSet(window->GetWindowHandle(),
                                 space_name.empty() ? "Space" : space_name.c_str(),
                                 profile_name.empty() ? "Default" : profile_name.c_str(),
                                 presentation_socket.c_str());
      }
    }
  }

  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override {
    UfoCefShellControlsClear();
    UfoCefSpaceControllerClear();
    if (auto* handler = UfoCefHandler::GetInstance()) {
      if (space_id_ > 0) {
        handler->SetSpaceAgentConnectionActive(space_id_, false);
      } else if (main_window_) {
        handler->SetAgentConnectionActive(false);
      }
    }
    if (main_window_) {
      if (auto* handler = UfoCefHandler::GetInstance()) {
        handler->SetMainWindow(nullptr);
      }
    }
    if (space_id_ > 0) {
      if (auto* handler = UfoCefHandler::GetInstance()) {
        handler->RegisterSpaceWindow(space_id_, nullptr);
      }
    }
    browser_view_ = nullptr;
  }

  bool CanClose(CefRefPtr<CefWindow> window) override {
    auto browser = browser_view_ ? browser_view_->GetBrowser() : nullptr;
    return !browser || browser->GetHost()->TryCloseBrowser();
  }

  CefSize GetPreferredSize(CefRefPtr<CefView> view) override {
    return CefSize(1280, 800);
  }

  cef_runtime_style_t GetWindowRuntimeStyle() override {
    return CEF_RUNTIME_STYLE_CHROME;
  }

 private:
  CefRefPtr<CefBrowserView> browser_view_;
  bool present_on_start_ = false;
  bool show_shell_controls_ = false;
  bool main_window_ = true;
  int space_id_ = 0;
  std::string space_name_;
  std::string profile_name_;
  std::string presentation_socket_;

  IMPLEMENT_REFCOUNTING(UfoWindowDelegate);
};

class UfoBrowserViewDelegate final : public CefBrowserViewDelegate {
 public:
  explicit UfoBrowserViewDelegate(bool chrome_shell)
      : chrome_shell_(chrome_shell) {}

  bool OnPopupBrowserViewCreated(CefRefPtr<CefBrowserView> browser_view,
                                 CefRefPtr<CefBrowserView> popup_browser_view,
                                 bool is_devtools) override {
    // Browser popups/dialogs are real Chrome windows and should be visible to
    // a human immediately. Agent-created popup targets remain controllable
    // through CDP even if their page later receives the outer Agent overlay.
    if (auto* handler = UfoCefHandler::GetInstance()) {
      handler->RegisterPopupBrowser(browser_view->GetBrowser(),
                                    popup_browser_view->GetBrowser());
    }
    CefWindow::CreateTopLevelWindow(
        new UfoWindowDelegate(popup_browser_view, true, false, false));
    return true;
  }

  cef_runtime_style_t GetBrowserRuntimeStyle() override {
    return CEF_RUNTIME_STYLE_CHROME;
  }

  // Chrome Runtime does not create the browser toolbar unless the delegate
  // explicitly opts into one of the native toolbar variants. CEF's default is
  // CEF_CTT_NONE, which looks like a plain web window even when the runtime
  // style is Chrome. Use the full native toolbar to match cefclient/Ego:
  // tabs, navigation, omnibox, profile menu, and browser commands are all
  // supplied by Chromium itself.
  ChromeToolbarType GetChromeToolbarType(
      CefRefPtr<CefBrowserView> browser_view) override {
    return chrome_shell_ ? CEF_CTT_NORMAL : CEF_CTT_NONE;
  }

 private:
  const bool chrome_shell_;
  IMPLEMENT_REFCOUNTING(UfoBrowserViewDelegate);
};

class UfoOverviewBrowserViewDelegate final : public CefBrowserViewDelegate {
 public:
  cef_runtime_style_t GetBrowserRuntimeStyle() override {
    return CEF_RUNTIME_STYLE_CHROME;
  }

  ChromeToolbarType GetChromeToolbarType(
      CefRefPtr<CefBrowserView> browser_view) override {
    return CEF_CTT_NONE;
  }

 private:
  IMPLEMENT_REFCOUNTING(UfoOverviewBrowserViewDelegate);
};

std::string StartupUrl() {
  auto command_line = CefCommandLine::GetGlobalCommandLine();
  const auto url = command_line->GetSwitchValue("url");
  return url.empty() ? "https://www.google.com/" : url.ToString();
}

bool CreateSharedSpace(CefRefPtr<UfoCefHandler> handler,
                       CefRefPtr<CefDictionaryValue> spec,
                       const std::string& presentation_socket) {
  if (!spec) return false;
  const int space_id = spec->GetInt("id");
  const auto url = spec->GetString("url").ToString();
  const auto cache_path = spec->GetString("cachePath").ToString();
  if (space_id <= 0 || url.empty() || cache_path.empty()) return false;

  CefRequestContextSettings context_settings;
  const auto canonical_cache = std::filesystem::weakly_canonical(
      std::filesystem::path(cache_path));
  CefString(&context_settings.cache_path) = canonical_cache.string();
  context_settings.persist_session_cookies = true;
  auto request_context =
      CefRequestContext::CreateContext(context_settings, nullptr);
  if (!request_context) return false;

  CefBrowserSettings browser_settings;
  auto browser_view = CefBrowserView::CreateBrowserView(
      handler, url, browser_settings, nullptr, request_context,
      new UfoBrowserViewDelegate(true));
  CefWindow::CreateTopLevelWindow(new UfoWindowDelegate(
      browser_view,
      spec->GetBool("visible"),
      true,
      false,
      space_id,
      spec->GetString("name").ToString(),
      spec->GetString("profileName").ToString(),
      presentation_socket));
  return true;
}

void CreateSharedManifestSpaces(CefRefPtr<UfoCefHandler> handler,
                                CefRefPtr<CefCommandLine> command_line) {
  const auto manifest_path =
      command_line->GetSwitchValue("shared-space-manifest").ToString();
  if (manifest_path.empty()) return;
  std::ifstream stream(manifest_path);
  if (!stream) return;
  std::ostringstream contents;
  contents << stream.rdbuf();
  auto parsed = CefParseJSON(contents.str(), JSON_PARSER_RFC);
  auto root = parsed ? parsed->GetDictionary() : nullptr;
  auto spaces = root ? root->GetList("spaces") : nullptr;
  if (!spaces) return;
  const auto presentation_socket =
      command_line->GetSwitchValue("presentation-socket").ToString();
  for (size_t index = 0; index < spaces->GetSize(); ++index) {
    (void)CreateSharedSpace(handler, spaces->GetDictionary(index),
                            presentation_socket);
  }
}

std::string CreateSharedSpaceFromCommand(
    CefRefPtr<UfoCefHandler> handler,
    const std::string& presentation_socket,
    const std::string& command) {
  auto parsed = CefParseJSON(command, JSON_PARSER_RFC);
  auto root = parsed ? parsed->GetDictionary() : nullptr;
  auto spec = root ? root->GetDictionary("space") : nullptr;
  if (!spec) return "error invalid-space";
  const int space_id = spec->GetInt("id");
  if (!CreateSharedSpace(handler, spec, presentation_socket)) {
    return "error create-space-failed";
  }
  return std::string("{\"ok\":true,\"spaceId\":") +
      std::to_string(space_id) + ",\"browserRoute\":\"space:" +
      std::to_string(space_id) + "\"}";
}

}  // namespace

void UfoCefApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();

  const auto command_line = CefCommandLine::GetGlobalCommandLine();
  const bool overview = command_line->HasSwitch("overview");
  // A non-Overview CEF host is a real browser shell by default. The explicit
  // switch is passed by UFO's runtime and makes the product invariant visible
  // in process inspection; --plain-page remains available only for host-level
  // diagnostics that intentionally want a page without browser chrome.
  const bool chrome_shell = !overview &&
      (command_line->HasSwitch("chrome-shell") ||
       !command_line->HasSwitch("plain-page"));
  auto handler = CefRefPtr<UfoCefHandler>(new UfoCefHandler(chrome_shell));
  const auto control_socket = command_line->GetSwitchValue("control-socket").ToString();
  if (!control_socket.empty()) handler->StartControlSocket(control_socket);
  const auto devtools_socket = command_line->GetSwitchValue("devtools-socket").ToString();
  if (!devtools_socket.empty()) handler->StartDevToolsSocket(devtools_socket);
  const auto presentation_socket =
      command_line->GetSwitchValue("presentation-socket").ToString();
  handler->SetPresentationSocket(presentation_socket);
  auto* handler_raw = handler.get();
  handler->SetSharedSpaceFactory(
      [handler_raw, presentation_socket](const std::string& command) {
        return CreateSharedSpaceFromCommand(handler_raw, presentation_socket,
                                            command);
      });
  CefBrowserSettings browser_settings;
  auto browser_view = CefBrowserView::CreateBrowserView(
      handler, StartupUrl(), browser_settings, nullptr, nullptr,
      overview ? static_cast<CefRefPtr<CefBrowserViewDelegate>>(
          new UfoOverviewBrowserViewDelegate())
               : static_cast<CefRefPtr<CefBrowserViewDelegate>>(
          new UfoBrowserViewDelegate(chrome_shell)));
  CefWindow::CreateTopLevelWindow(
      new UfoWindowDelegate(browser_view, false, !overview));
  CreateSharedManifestSpaces(handler, command_line);
}

CefRefPtr<CefClient> UfoCefApp::GetDefaultClient() {
  return UfoCefHandler::GetInstance();
}
