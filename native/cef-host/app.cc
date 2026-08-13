#include "native/cef-host/app.h"

#include <string>

#include "include/cef_browser.h"
#include "include/cef_command_line.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_helpers.h"
#include "native/cef-host/handler.h"
#include "native/cef-host/overlay_mac.h"

namespace {

class UfoWindowDelegate final : public CefWindowDelegate {
 public:
  explicit UfoWindowDelegate(CefRefPtr<CefBrowserView> browser_view,
                             bool present_on_start = false)
      : browser_view_(browser_view), present_on_start_(present_on_start) {}

  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    window->AddChildView(browser_view_);
    if (auto* handler = UfoCefHandler::GetInstance()) handler->SetMainWindow(window);
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
  }

  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override {
    if (auto* handler = UfoCefHandler::GetInstance()) handler->SetAgentConnectionActive(false);
    if (auto* handler = UfoCefHandler::GetInstance()) handler->SetMainWindow(nullptr);
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

  IMPLEMENT_REFCOUNTING(UfoWindowDelegate);
};

class UfoBrowserViewDelegate final : public CefBrowserViewDelegate {
 public:
  bool OnPopupBrowserViewCreated(CefRefPtr<CefBrowserView> browser_view,
                                 CefRefPtr<CefBrowserView> popup_browser_view,
                                 bool is_devtools) override {
    // Browser popups/dialogs are real Chrome windows and should be visible to
    // a human immediately. Agent-created popup targets remain controllable
    // through CDP even if their page later receives the outer Agent overlay.
    CefWindow::CreateTopLevelWindow(
        new UfoWindowDelegate(popup_browser_view, true));
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
    return CEF_CTT_NORMAL;
  }

 private:
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

}  // namespace

void UfoCefApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();

  auto handler = CefRefPtr<UfoCefHandler>(new UfoCefHandler(true));
  const auto command_line = CefCommandLine::GetGlobalCommandLine();
  const auto control_socket = command_line->GetSwitchValue("control-socket").ToString();
  if (!control_socket.empty()) handler->StartControlSocket(control_socket);
  const auto devtools_socket = command_line->GetSwitchValue("devtools-socket").ToString();
  if (!devtools_socket.empty()) handler->StartDevToolsSocket(devtools_socket);
  CefBrowserSettings browser_settings;
  const bool overview = command_line->HasSwitch("overview");
  auto browser_view = CefBrowserView::CreateBrowserView(
      handler, StartupUrl(), browser_settings, nullptr, nullptr,
      overview ? static_cast<CefRefPtr<CefBrowserViewDelegate>>(
          new UfoOverviewBrowserViewDelegate())
               : static_cast<CefRefPtr<CefBrowserViewDelegate>>(
          new UfoBrowserViewDelegate()));
  CefWindow::CreateTopLevelWindow(new UfoWindowDelegate(browser_view));
}

CefRefPtr<CefClient> UfoCefApp::GetDefaultClient() {
  return UfoCefHandler::GetInstance();
}
