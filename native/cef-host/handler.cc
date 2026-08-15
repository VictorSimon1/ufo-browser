#include "native/cef-host/handler.h"

#include <algorithm>
#include <cstring>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <filesystem>
#include <sstream>
#include <utility>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "include/cef_app.h"
#include "include/cef_command_line.h"
#include "include/cef_cookie.h"
#include "include/cef_id_mappers.h"
#include "include/cef_parser.h"
#include "include/cef_values.h"
#include "include/cef_devtools_message_observer.h"
#include "include/base/cef_callback.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/wrapper/cef_helpers.h"
#include "native/cef-host/overlay_mac.h"

namespace {
UfoCefHandler* g_instance = nullptr;

std::string JsonString(CefRefPtr<CefValue> value) {
  return CefWriteJSON(value, JSON_WRITER_DEFAULT).ToString();
}

class UfoDevToolsObserver final : public CefDevToolsMessageObserver {
 public:
  UfoDevToolsObserver(CefRefPtr<UfoCefHandler> handler, std::string route_id)
      : handler_(std::move(handler)), route_id_(std::move(route_id)) {}

  bool OnDevToolsMessage(CefRefPtr<CefBrowser> browser,
                         const void* message,
                         size_t message_size) override {
    (void)browser;
    if (!message || message_size == 0) return false;
    const std::string raw(static_cast<const char*>(message), message_size);
    auto parsed = CefParseJSON(raw, JSON_PARSER_RFC);
    if (parsed && parsed->GetDictionary()) {
      const auto dictionary = parsed->GetDictionary();
      const int id = dictionary->GetInt("id");
      if (id != 0 && handler_->ConsumeDevToolsOuterResult(route_id_, id)) return true;
      if (dictionary->GetString("method") == "Target.receivedMessageFromTarget") {
        const auto params = dictionary->GetDictionary("params");
        if (params) {
          const auto nested = params->GetString("message");
          if (!nested.empty()) {
            handler_->PublishDevToolsMessage(route_id_, nested.ToString());
            return true;
          }
        }
      }
    }
    handler_->PublishDevToolsMessage(route_id_, raw);
    // The raw message is already the standard CDP envelope. Returning true
    // prevents CEF from delivering a duplicate structured callback.
    return true;
  }

  void OnDevToolsMethodResult(CefRefPtr<CefBrowser> browser,
                              int message_id,
                              bool success,
                              const void* result,
                              size_t result_size) override {
    (void)browser;
    (void)message_id;
    (void)success;
    (void)result;
    (void)result_size;
  }

  void OnDevToolsEvent(CefRefPtr<CefBrowser> browser,
                       const CefString& method,
                       const void* params,
                       size_t params_size) override {
    (void)browser;
    (void)method;
    (void)params;
    (void)params_size;
  }

 private:
  // Keep the owner alive for the lifetime of CEF's observer callbacks.  The
  // previous raw pointer could be called after app shutdown and crash in
  // ConsumeDevToolsOuterResult/PublishDevToolsMessage.
  CefRefPtr<UfoCefHandler> handler_;
  const std::string route_id_;
  IMPLEMENT_REFCOUNTING(UfoDevToolsObserver);
};

class UfoCookieFlushCallback final : public CefCompletionCallback {
 public:
  UfoCookieFlushCallback(CefRefPtr<UfoCefHandler> handler, int space_id)
      : handler_(std::move(handler)), space_id_(space_id) {}

  void OnComplete() override {
    if (space_id_ > 0) handler_->OnSpaceCookieStoreFlushed(space_id_);
    else handler_->OnApplicationCookieStoreFlushed();
  }

 private:
  CefRefPtr<UfoCefHandler> handler_;
  const int space_id_;
  IMPLEMENT_REFCOUNTING(UfoCookieFlushCallback);
};
}

struct UfoCefHandler::DevToolsClient {
  explicit DevToolsClient(int socket_fd) : fd(socket_fd) {}
  int fd = -1;
  std::mutex write_mutex;
  std::string route_id;
  std::string target_id;
  std::string browser_route;
};

UfoCefHandler::UfoCefHandler(bool chrome_style)
    : chrome_style_(chrome_style) {
  DCHECK(!g_instance);
  g_instance = this;
}

UfoCefHandler::~UfoCefHandler() {
  SetAgentConnectionActive(false);
  StopDevToolsSocket();
  StopControlSocket();
  g_instance = nullptr;
}

UfoCefHandler* UfoCefHandler::GetInstance() {
  return g_instance;
}

void UfoCefHandler::OnTitleChange(CefRefPtr<CefBrowser> browser,
                                   const CefString& title) {
  CEF_REQUIRE_UI_THREAD();
  auto browser_view = CefBrowserView::GetForBrowser(browser);
  auto window = browser_view ? browser_view->GetWindow() : nullptr;
  if (window) window->SetTitle(title);
}

bool UfoCefHandler::OnBeforeDownload(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefDownloadItem> download_item,
    const CefString& suggested_name,
    CefRefPtr<CefBeforeDownloadCallback> callback) {
  CEF_REQUIRE_UI_THREAD();
  if (!browser || !callback) return false;
  std::string download_dir;
  {
    std::lock_guard<std::mutex> lock(devtools_targets_mutex_);
    const auto request_context = browser->GetHost()->GetRequestContext();
    const auto cache_path = request_context
        ? request_context->GetCachePath().ToString()
        : std::string();
    const auto context_configured = context_download_dirs_.find(cache_path);
    if (!cache_path.empty() && context_configured != context_download_dirs_.end()) {
      download_dir = context_configured->second;
    }
    const auto configured = browser_download_dirs_.find(browser->GetIdentifier());
    if (download_dir.empty() && configured != browser_download_dirs_.end()) {
      download_dir = configured->second;
    } else if (download_dir.empty()) {
      const auto owner = browser_spaces_.find(browser->GetIdentifier());
      if (owner != browser_spaces_.end()) {
        const auto primary = space_browsers_.find(owner->second);
        if (primary != space_browsers_.end()) {
          const auto inherited = browser_download_dirs_.find(primary->second);
          if (inherited != browser_download_dirs_.end()) {
            download_dir = inherited->second;
          }
        }
      }
    }
  }
  if (download_dir.empty()) return false;
  const auto safe_name = std::filesystem::path(suggested_name.ToString()).filename();
  std::filesystem::create_directories(download_dir);
  callback->Continue((std::filesystem::path(download_dir) / safe_name).string(),
                     false);
  return true;
}

void UfoCefHandler::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  browsers_.push_back(browser);
  const auto command_line = CefCommandLine::GetGlobalCommandLine();
  const bool overview_host = UfoCefPackagedHostPrepared() ||
                             command_line->HasSwitch("overview");
  if (overview_host && browsers_.size() == 1 && !browser->IsPopup()) {
    main_overview_browser_id_ = browser->GetIdentifier();
    // Chrome Runtime creates its internal top-chrome renderers immediately
    // after the CefBrowser callback. Let that registration settle before the
    // Agent can create another native Chrome window in this same process.
    CefPostDelayedTask(
        TID_UI,
        base::BindOnce(&UfoCefHandler::MarkOverviewReady,
                       CefRefPtr<UfoCefHandler>(this),
                       browser->GetIdentifier()),
        500);
  }
  const auto target_id = std::to_string(browser->GetIdentifier());
  const auto request_context = browser->GetHost()->GetRequestContext();
  const auto cache_path = request_context
      ? request_context->GetCachePath().ToString()
      : std::string();
  PendingNativeSpace pending_native_space;
  bool is_native_space_primary = false;
  {
    std::lock_guard<std::mutex> lock(devtools_targets_mutex_);
    devtools_target_browsers_[target_id] = browser->GetIdentifier();
    auto pending = pending_native_spaces_.find(cache_path);
    if (pending == pending_native_spaces_.end() || pending->second.empty()) {
      // Native Chrome windows use CEF 151's process-wide BrowserContext, so
      // their reported cache path is the global root rather than the selected
      // Profile staging directory used as the creation key. Space creation is
      // serialized by the manager; consume the one pending native window in
      // that same order and keep its logical Profile metadata on the Space.
      pending = std::find_if(
          pending_native_spaces_.begin(), pending_native_spaces_.end(),
          [](const auto& entry) { return !entry.second.empty(); });
    }
    if (!cache_path.empty() && pending != pending_native_spaces_.end() &&
        !pending->second.empty()) {
      pending_native_space = pending->second.front();
      pending->second.pop_front();
      if (pending->second.empty()) pending_native_spaces_.erase(pending);
      native_context_spaces_[cache_path].insert(
          pending_native_space.space_id);
      browser_spaces_[browser->GetIdentifier()] =
          pending_native_space.space_id;
      space_browsers_[pending_native_space.space_id] =
          browser->GetIdentifier();
      is_native_space_primary = true;
    } else {
      const int opener_id = browser->GetHost()->GetOpenerIdentifier();
      const auto opener_space = browser_spaces_.find(opener_id);
      if (opener_id > 0 && opener_space != browser_spaces_.end()) {
        browser_spaces_[browser->GetIdentifier()] = opener_space->second;
      } else {
        const auto pending_browser =
            pending_context_browser_spaces_.find(cache_path);
        if (!cache_path.empty() &&
            pending_browser != pending_context_browser_spaces_.end() &&
            !pending_browser->second.empty()) {
          browser_spaces_[browser->GetIdentifier()] =
              pending_browser->second.front();
          pending_browser->second.pop_front();
          if (pending_browser->second.empty()) {
            pending_context_browser_spaces_.erase(pending_browser);
          }
        } else {
          const auto context_spaces = native_context_spaces_.find(cache_path);
          if (!cache_path.empty() &&
              context_spaces != native_context_spaces_.end() &&
              context_spaces->second.size() == 1) {
            // Every Chrome tab in a native-hosted window shares the Space's
            // RequestContext. The context fallback is only safe while exactly
            // one Space owns that Profile; shared Chrome Profiles use opener
            // or pending-window routing so tabs cannot jump between Spaces.
            browser_spaces_[browser->GetIdentifier()] =
                *context_spaces->second.begin();
          }
        }
      }
    }
  }
  if (is_native_space_primary) {
    const int space_id = pending_native_space.space_id;
    native_space_browsers_[space_id] = browser;
    native_space_contexts_[space_id] = cache_path;
    native_space_specs_[space_id] = pending_native_space;
    ConfigureNativeSpaceWindow(space_id);
    const auto frame = browser->GetMainFrame();
    if (frame && !pending_native_space.url.empty() &&
        frame->GetURL().ToString() != pending_native_space.url) {
      frame->LoadURL(pending_native_space.url);
    }
  }
}

bool UfoCefHandler::DoClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  if (browsers_.size() == 1) closing_ = true;
  // Returning true tells CEF that the application handled the close and
  // prevents the Chrome Runtime window from entering its normal destruction
  // path. That leaves the host and GPU/renderer helpers alive after SIGTERM.
  // Mark the final browser as closing, then let CEF continue to OnBeforeClose
  // where the message loop is shut down cleanly.
  return false;
}

void UfoCefHandler::OnBeforeClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  for (auto it = browsers_.begin(); it != browsers_.end(); ++it) {
    if ((*it)->IsSame(browser)) {
      browsers_.erase(it);
      break;
    }
  }
  int closed_space_id = 0;
  bool closed_native_primary = false;
  CefRefPtr<CefBrowser> replacement_primary;
  {
    std::lock_guard<std::mutex> lock(devtools_targets_mutex_);
    devtools_target_browsers_.erase(std::to_string(browser->GetIdentifier()));
    if (main_overview_browser_id_ == browser->GetIdentifier()) {
      main_overview_browser_id_ = 0;
      main_overview_ready_ = false;
    }
    browser_download_dirs_.erase(browser->GetIdentifier());
    const auto space_it = browser_spaces_.find(browser->GetIdentifier());
    if (space_it != browser_spaces_.end()) {
      closed_space_id = space_it->second;
      const auto primary_it = space_browsers_.find(space_it->second);
      if (primary_it != space_browsers_.end() &&
          primary_it->second == browser->GetIdentifier()) {
        const auto native_primary = native_space_browsers_.find(space_it->second);
        closed_native_primary = native_primary != native_space_browsers_.end() &&
            native_primary->second && native_primary->second->IsSame(browser);
        for (const auto& candidate : browsers_) {
          const auto owner = browser_spaces_.find(candidate->GetIdentifier());
          if (owner != browser_spaces_.end() && owner->second == closed_space_id) {
            replacement_primary = candidate;
            break;
          }
        }
        if (replacement_primary) {
          primary_it->second = replacement_primary->GetIdentifier();
        } else {
          space_browsers_.erase(primary_it);
        }
      }
      browser_spaces_.erase(space_it);
    }
  }
  if (closed_native_primary && closed_space_id > 0) {
    if (replacement_primary) {
      // Closing the first tab must not orphan the Space. Promote a remaining
      // tab to the Browser-level Agent route and keep the same native window
      // registered with the presentation coordinator.
      native_space_browsers_[closed_space_id] = replacement_primary;
    } else {
      const auto handle = browser->GetHost()->GetWindowHandle();
      if (handle) {
        UfoAgentOverlayClear(handle);
        UfoCefNativeSpaceWindowClear(handle);
        UfoCefChromeControlsClear(handle);
      }
      native_space_browsers_.erase(closed_space_id);
      native_space_specs_.erase(closed_space_id);
      agent_task_titles_.erase(closed_space_id);
      agent_task_details_.erase(closed_space_id);
      space_cookie_flushes_.erase(closed_space_id);
      const auto context = native_space_contexts_.find(closed_space_id);
      if (context != native_space_contexts_.end()) {
        const auto pending_browsers =
            pending_context_browser_spaces_.find(context->second);
        if (pending_browsers != pending_context_browser_spaces_.end()) {
          std::erase(pending_browsers->second, closed_space_id);
          if (pending_browsers->second.empty()) {
            pending_context_browser_spaces_.erase(pending_browsers);
          }
        }
        const auto owners = native_context_spaces_.find(context->second);
        if (owners != native_context_spaces_.end()) {
          owners->second.erase(closed_space_id);
          if (owners->second.empty()) native_context_spaces_.erase(owners);
        }
        native_space_contexts_.erase(context);
      }
      closing_spaces_.erase(closed_space_id);
      agent_active_spaces_.erase(closed_space_id);
      if (visible_space_id_ == closed_space_id) visible_space_id_ = 0;
    }
  }
  if (browsers_.empty()) {
    StopControlSocket();
    CefQuitMessageLoop();
  }
}

void UfoCefHandler::OnLoadEnd(CefRefPtr<CefBrowser> browser,
                              CefRefPtr<CefFrame> frame,
                              int http_status_code) {
  CEF_REQUIRE_UI_THREAD();
  if (frame && frame->IsMain()) {
    const int space_id = GetBrowserSpaceId(browser);
    if (space_id == 0) {
      const auto overview_url = frame->GetURL().ToString();
      // Chrome Runtime 151 creates an internal top-chrome-webui Browser
      // before the application page Browser. Never publish that first
      // internal Browser as the Agent's process-level route: its renderer is
      // not a normal page target and browser-level CDP requests can block in
      // browser_info_manager. The real Overview is the first HTTP(S) main
      // frame loaded by UFO's local server (or a development URL).
      const bool application_page =
          overview_url.rfind("http://", 0) == 0 ||
          overview_url.rfind("https://", 0) == 0;
      if (application_page) {
        main_overview_browser_id_ = browser->GetIdentifier();
        MarkOverviewReady(browser->GetIdentifier());
      }
    } else {
      // Chrome Runtime may create a default Google/New Tab CefBrowser first
      // and the explicitly requested --new-window URL as a sibling browser a
      // moment later. The requested page must become the Space's primary
      // browser-level DevTools route; otherwise Target.getTargets/Page frame
      // commands remain scoped to the bootstrap tab and OOPIFs disappear from
      // Agent snapshots. Promote exactly once when the requested URL loads,
      // then close the now-redundant bootstrap tab.
      CefRefPtr<CefBrowser> bootstrap_browser;
      const auto spec = native_space_specs_.find(space_id);
      const auto loaded_url = frame->GetURL().ToString();
      if (spec != native_space_specs_.end() &&
          !spec->second.url.empty() &&
          (loaded_url == spec->second.url ||
           loaded_url.rfind(spec->second.url, 0) == 0)) {
        int previous_id = 0;
        {
          std::lock_guard<std::mutex> lock(devtools_targets_mutex_);
          const auto primary = space_browsers_.find(space_id);
          if (primary != space_browsers_.end() &&
              primary->second != browser->GetIdentifier()) {
            previous_id = primary->second;
            primary->second = browser->GetIdentifier();
          }
        }
        if (previous_id > 0) {
          for (const auto& candidate : browsers_) {
            if (candidate->GetIdentifier() == previous_id) {
              const auto previous_frame = candidate->GetMainFrame();
              const auto previous_url = previous_frame
                  ? previous_frame->GetURL().ToString()
                  : std::string();
              if (previous_url != loaded_url) bootstrap_browser = candidate;
              break;
            }
          }
          native_space_browsers_[space_id] = browser;
        }
      }
      frame->ExecuteJavaScript(
          std::string("globalThis.__ufoSpaceId=") +
              std::to_string(space_id) + ";",
          frame->GetURL(), 0);
      if (bootstrap_browser) {
        bootstrap_browser->GetHost()->CloseBrowser(false);
      }
    }
    LOG(INFO) << "UFO native Chrome loaded " << frame->GetURL().ToString()
              << " status=" << http_status_code;
  }
}

void UfoCefHandler::MarkOverviewReady(int browser_id) {
  CEF_REQUIRE_UI_THREAD();
  if (main_overview_ready_ || browser_id <= 0) return;
  const bool browser_alive = std::any_of(
      browsers_.begin(), browsers_.end(), [browser_id](const auto& browser) {
        return browser && browser->GetIdentifier() == browser_id;
      });
  if (!browser_alive) return;
  main_overview_browser_id_ = browser_id;
  main_overview_ready_ = true;
  if (!UfoCefReleasePackagedAgentAttach()) {
    UfoCefRequestProductTermination();
  }
}

void UfoCefHandler::CloseAllBrowsers(bool force_close) {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(&UfoCefHandler::CloseAllBrowsers, this,
                                      force_close));
    return;
  }
  for (const auto& browser : browsers_) browser->GetHost()->CloseBrowser(force_close);
}

void UfoCefHandler::RequestApplicationClose(bool force_close) {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(
        &UfoCefHandler::RequestApplicationClose, this, force_close));
    return;
  }
  if (closing_) return;
  closing_ = true;
  CefPostTask(TID_UI, base::BindOnce(
      &UfoCefHandler::FlushCookieStoresAndCloseBrowsers, this, force_close));
}

void UfoCefHandler::FlushCookieStoresAndCloseBrowsers(bool force_close) {
  CEF_REQUIRE_UI_THREAD();
  if (pending_application_cookie_flushes_ > 0) return;
  std::vector<CefRefPtr<CefCookieManager>> managers;
  std::set<std::string> contexts;
  for (const auto& browser : browsers_) {
    const auto context = browser->GetHost()->GetRequestContext();
    if (!context) continue;
    const auto key = context->GetCachePath().ToString();
    if (!contexts.insert(key).second) continue;
    const auto manager = context->GetCookieManager(nullptr);
    if (manager) managers.push_back(manager);
  }
  if (managers.empty()) {
    CloseAllBrowsers(force_close);
    return;
  }
  application_cookie_flush_force_close_ = force_close;
  pending_application_cookie_flushes_ = static_cast<int>(managers.size());
  for (const auto& manager : managers) {
    if (!manager->FlushStore(new UfoCookieFlushCallback(this, 0))) {
      OnApplicationCookieStoreFlushed();
    }
  }
}

void UfoCefHandler::OnApplicationCookieStoreFlushed() {
  CEF_REQUIRE_UI_THREAD();
  if (pending_application_cookie_flushes_ <= 0) return;
  pending_application_cookie_flushes_ -= 1;
  if (pending_application_cookie_flushes_ > 0) return;
  CloseAllBrowsers(application_cookie_flush_force_close_);
}

void UfoCefHandler::FlushNativeSpaceCookiesAndClose(int space_id) {
  CEF_REQUIRE_UI_THREAD();
  if (space_id <= 0 || space_cookie_flushes_.contains(space_id)) return;
  const auto browser = native_space_browsers_.find(space_id);
  if (browser == native_space_browsers_.end() || !browser->second) {
    FinishNativeSpaceClose(space_id);
    return;
  }
  const auto context = browser->second->GetHost()->GetRequestContext();
  const auto manager = context ? context->GetCookieManager(nullptr) : nullptr;
  if (!manager) {
    FinishNativeSpaceClose(space_id);
    return;
  }
  space_cookie_flushes_.insert(space_id);
  if (!manager->FlushStore(new UfoCookieFlushCallback(this, space_id))) {
    OnSpaceCookieStoreFlushed(space_id);
  }
}

void UfoCefHandler::OnSpaceCookieStoreFlushed(int space_id) {
  CEF_REQUIRE_UI_THREAD();
  space_cookie_flushes_.erase(space_id);
  FinishNativeSpaceClose(space_id);
}

void UfoCefHandler::FinishNativeSpaceClose(int space_id) {
  CEF_REQUIRE_UI_THREAD();
  const auto browser = native_space_browsers_.find(space_id);
  if (browser == native_space_browsers_.end() || !browser->second) return;
  const int command_id = cef_id_for_command_id_name("IDC_CLOSE_WINDOW");
  if (command_id > 0 &&
      browser->second->GetHost()->CanExecuteChromeCommand(command_id)) {
    browser->second->GetHost()->ExecuteChromeCommand(
        command_id, CEF_WOD_CURRENT_TAB);
  } else {
    browser->second->GetHost()->CloseBrowser(false);
  }
}

void UfoCefHandler::ShowMainWindow() {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(&UfoCefHandler::ShowMainWindow, this));
    return;
  }
  if (main_window_ && !main_window_->IsClosed()) {
    UfoCefWindowSetCompositorAwake(main_window_->GetWindowHandle(), true);
    main_window_->Show();
  }
  if (main_window_ && !main_window_->IsClosed()) {
    SetVisibleSpace(0);
    UfoCefWindowSetPresented(main_window_->GetWindowHandle(), true);
  }
}

void UfoCefHandler::HideMainWindow() {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(&UfoCefHandler::HideMainWindow, this));
    return;
  }
  if (main_window_ && !main_window_->IsClosed()) {
    UfoCefWindowSetPresented(main_window_->GetWindowHandle(), false);
    UfoCefWindowSetCompositorAwake(main_window_->GetWindowHandle(), false);
  }
}

void UfoCefHandler::FocusMainWindow() {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(&UfoCefHandler::FocusMainWindow, this));
    return;
  }
  if (main_window_ && !main_window_->IsClosed()) {
    UfoCefWindowSetCompositorAwake(main_window_->GetWindowHandle(), true);
    SetVisibleSpace(0);
    main_window_->Show();
    UfoCefWindowSetPresented(main_window_->GetWindowHandle(), true);
    main_window_->Activate();
    main_window_->BringToTop();
  }
}

void UfoCefHandler::SetMainWindow(CefRefPtr<CefWindow> window) {
  CEF_REQUIRE_UI_THREAD();
  if (!window) {
    if (main_window_ && !main_window_->IsClosed()) {
      UfoAgentOverlayClear(main_window_->GetWindowHandle());
      UfoCefProductControllerClear(main_window_->GetWindowHandle());
    }
    main_window_ = nullptr;
    return;
  }
  main_window_ = window;
  UfoCefProductControllerSet(main_window_->GetWindowHandle());
  if (agent_active_ && main_window_) {
    UfoAgentOverlaySet(main_window_->GetWindowHandle(), true,
                       "Browser Agent", "Agent 正在控制", 0, nullptr);
  }
}

void UfoCefHandler::RegisterBrowserSpace(CefRefPtr<CefBrowser> browser,
                                         int space_id) {
  CEF_REQUIRE_UI_THREAD();
  if (!browser || space_id <= 0) return;
  std::lock_guard<std::mutex> lock(devtools_targets_mutex_);
  browser_spaces_[browser->GetIdentifier()] = space_id;
  space_browsers_[space_id] = browser->GetIdentifier();
}

void UfoCefHandler::RegisterPopupBrowser(CefRefPtr<CefBrowser> parent,
                                         CefRefPtr<CefBrowser> popup) {
  CEF_REQUIRE_UI_THREAD();
  if (!parent || !popup) return;
  std::lock_guard<std::mutex> lock(devtools_targets_mutex_);
  const auto owner = browser_spaces_.find(parent->GetIdentifier());
  if (owner == browser_spaces_.end()) return;
  // A popup is another CefBrowser inside the same UFO Host and logical Space.
  // It intentionally does not replace space_browsers_[spaceId], which remains
  // the primary Browser-level endpoint for native tab creation/enumeration.
  browser_spaces_[popup->GetIdentifier()] = owner->second;
}

void UfoCefHandler::RegisterSpaceWindow(int space_id,
                                        CefRefPtr<CefWindow> window) {
  CEF_REQUIRE_UI_THREAD();
  if (space_id <= 0) return;
  if (window) {
    space_windows_[space_id] = window;
  } else {
    space_windows_.erase(space_id);
    closing_spaces_.erase(space_id);
  }
}

void UfoCefHandler::RegisterPendingNativeSpace(
    const std::string& cache_path,
    int space_id,
    bool visible,
    std::string url,
    std::string space_name,
    std::string profile_name) {
  CEF_REQUIRE_UI_THREAD();
  if (cache_path.empty() || space_id <= 0) return;
  pending_native_spaces_[cache_path].push_back(PendingNativeSpace{
      space_id,
      visible,
      std::move(url),
      std::move(space_name),
      std::move(profile_name),
  });
}

void UfoCefHandler::CancelPendingNativeSpace(const std::string& cache_path,
                                             int space_id) {
  CEF_REQUIRE_UI_THREAD();
  const auto pending = pending_native_spaces_.find(cache_path);
  if (pending == pending_native_spaces_.end()) return;
  std::erase_if(pending->second, [space_id](const PendingNativeSpace& spec) {
    return spec.space_id == space_id;
  });
  if (pending->second.empty()) pending_native_spaces_.erase(pending);
}

void UfoCefHandler::SetMainChromeToolbarAttached(bool attached) {
  CEF_REQUIRE_UI_THREAD();
  main_chrome_toolbar_attached_ = attached;
}

void UfoCefHandler::SetSpaceChromeToolbarAttached(int space_id,
                                                  bool attached) {
  CEF_REQUIRE_UI_THREAD();
  if (space_id <= 0) return;
  if (attached) {
    chrome_toolbar_spaces_.insert(space_id);
  } else {
    chrome_toolbar_spaces_.erase(space_id);
  }
}

bool UfoCefHandler::IsSpaceAgentConnectionActive(int space_id) const {
  return space_id > 0 && agent_active_spaces_.count(space_id) > 0;
}

bool UfoCefHandler::IsSpaceCloseAuthorized(int space_id) const {
  return closing_ || (space_id > 0 && closing_spaces_.count(space_id) > 0);
}

CefWindowHandle UfoCefHandler::GetSpaceWindowHandle(int space_id) const {
  const auto views_window = space_windows_.find(space_id);
  if (views_window != space_windows_.end() && views_window->second &&
      !views_window->second->IsClosed()) {
    return views_window->second->GetWindowHandle();
  }
  const auto native_browser = native_space_browsers_.find(space_id);
  if (native_browser != native_space_browsers_.end() &&
      native_browser->second) {
    return native_browser->second->GetHost()->GetWindowHandle();
  }
  return nullptr;
}

void UfoCefHandler::ConfigureNativeSpaceWindow(int space_id, int attempt) {
  CEF_REQUIRE_UI_THREAD();
  const auto browser = native_space_browsers_.find(space_id);
  const auto spec = native_space_specs_.find(space_id);
  if (browser == native_space_browsers_.end() || !browser->second ||
      spec == native_space_specs_.end()) {
    return;
  }
  const auto handle = browser->second->GetHost()->GetWindowHandle();
  if (!handle) {
    if (attempt < 40) {
      CefPostDelayedTask(
          TID_UI,
          base::BindOnce(&UfoCefHandler::ConfigureNativeSpaceWindow, this,
                         space_id, attempt + 1),
          25);
    }
    return;
  }
  // Native Chrome may publish the CefBrowser before its NSWindow handle is
  // ready. Apply initial hidden/presented state only at this boundary; without
  // the retry a background Agent Space briefly becomes a second visible
  // product window during cold startup.
  UfoCefWindowSetPresented(handle, spec->second.visible);
  UfoCefWindowSetCompositorAwake(handle, spec->second.visible);
  // Preserve the UFO return-to-Spaces affordance as a small AppKit button
  // above Chromium's tab strip. Do not install the old wide Space pill; the
  // native Chrome tab strip remains visually and interactively intact.
  UfoCefShellControlsSet(handle, presentation_socket_.c_str());
  UfoCefNativeSpaceWindowSet(
      handle, space_id, presentation_socket_.c_str(),
      agent_active_spaces_.contains(space_id));
}

void UfoCefHandler::SetPresentationSocket(std::string path) {
  CEF_REQUIRE_UI_THREAD();
  presentation_socket_ = std::move(path);
}

void UfoCefHandler::SetSharedSpaceFactory(
    std::function<std::string(const std::string&)> factory) {
  CEF_REQUIRE_UI_THREAD();
  shared_space_factory_ = std::move(factory);
}

void UfoCefHandler::SetAgentConnectionActive(bool active) {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(&UfoCefHandler::SetAgentConnectionActive, this, active));
    return;
  }
  agent_active_ = active;
  if (!main_window_ || main_window_->IsClosed()) return;
  if (active) {
    UfoAgentOverlaySet(main_window_->GetWindowHandle(), true,
                       "Browser Agent", "Agent 正在控制", 0, nullptr);
  }
  else UfoAgentOverlayClear(main_window_->GetWindowHandle());
}

void UfoCefHandler::SetSpaceAgentConnectionActive(int space_id, bool active) {
  CEF_REQUIRE_UI_THREAD();
  if (space_id <= 0) return;
  if (active) agent_active_spaces_.insert(space_id);
  else agent_active_spaces_.erase(space_id);
  const auto handle = GetSpaceWindowHandle(space_id);
  if (handle && native_space_browsers_.contains(space_id)) {
    UfoCefNativeSpaceWindowSetAgentActive(handle, active);
  }
  SetSpaceCompositorAwake(space_id, active || visible_space_id_ == space_id);
  if (visible_space_id_ == space_id) SetVisibleSpace(space_id);
}

void UfoCefHandler::SetSpaceCompositorAwake(int space_id, bool awake) {
  CEF_REQUIRE_UI_THREAD();
  const auto handle = GetSpaceWindowHandle(space_id);
  if (!handle) return;
  if (!awake && (visible_space_id_ == space_id ||
                 agent_active_spaces_.contains(space_id))) {
    return;
  }
  UfoCefWindowSetCompositorAwake(handle, awake);
}

void UfoCefHandler::SetVisibleSpace(int space_id) {
  CEF_REQUIRE_UI_THREAD();
  if (visible_space_id_ > 0) {
    const auto previous = GetSpaceWindowHandle(visible_space_id_);
    if (previous) UfoAgentOverlayClear(previous);
  }
  visible_space_id_ = space_id;
  const bool active = space_id > 0 && agent_active_spaces_.contains(space_id);
  agent_active_ = active;
  if (!active) return;
  const auto current = GetSpaceWindowHandle(space_id);
  if (current) {
    const auto spec = native_space_specs_.find(space_id);
    const auto title = agent_task_titles_.find(space_id);
    const auto detail = agent_task_details_.find(space_id);
    const std::string overlay_title = title != agent_task_titles_.end()
        ? title->second
        : (spec != native_space_specs_.end() ? spec->second.space_name
                                             : "Browser Agent");
    const std::string overlay_detail = detail != agent_task_details_.end()
        ? detail->second
        : "Agent 正在控制";
    UfoAgentOverlaySet(current, true,
                       overlay_title.c_str(), overlay_detail.c_str(), space_id,
                       presentation_socket_.c_str());
  }
}

void UfoCefHandler::StartControlSocket(const std::string& path) {
  if (path.empty() || control_running_) return;
  control_socket_path_ = path;
  ::unlink(path.c_str());
  control_socket_fd_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (control_socket_fd_ < 0) return;
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  if (path.size() >= sizeof(address.sun_path)) {
    ::close(control_socket_fd_);
    control_socket_fd_ = -1;
    return;
  }
  std::strncpy(address.sun_path, path.c_str(), sizeof(address.sun_path) - 1);
  if (::bind(control_socket_fd_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0 ||
      ::listen(control_socket_fd_, 8) != 0) {
    ::close(control_socket_fd_);
    control_socket_fd_ = -1;
    return;
  }
  control_running_ = true;
  control_thread_ = std::thread([this]() {
    while (control_running_) {
      const int client = ::accept(control_socket_fd_, nullptr, nullptr);
      if (client < 0) {
        if (control_running_) continue;
        break;
      }
      std::string command;
      char buffer[4096];
      while (command.size() < 64 * 1024) {
        const ssize_t count = ::read(client, buffer, sizeof(buffer));
        if (count <= 0) break;
        command.append(buffer, static_cast<size_t>(count));
        if (command.find('\n') != std::string::npos) break;
      }
      if (const auto newline = command.find('\n'); newline != std::string::npos) {
        command.resize(newline);
      }
      struct SharedResult {
        std::mutex mutex;
        std::condition_variable ready;
        bool complete = false;
        std::string response;
      };
      auto result = std::make_shared<SharedResult>();
      CefPostTask(TID_UI, base::BindOnce(
          [](UfoCefHandler* handler, std::shared_ptr<SharedResult> result,
             std::string command) {
            const auto response = handler->HandleControlCommandOnUi(command);
            {
              std::lock_guard<std::mutex> lock(result->mutex);
              result->response = response;
              result->complete = true;
            }
            result->ready.notify_one();
          },
          base::Unretained(this), result, command));
      std::unique_lock<std::mutex> lock(result->mutex);
      if (!result->ready.wait_for(lock, std::chrono::seconds(10),
                                  [&result] { return result->complete; })) {
        result->response = "error control-timeout";
      }
      const std::string response = result->response + "\n";
      size_t written = 0;
      while (written < response.size()) {
        const ssize_t count = ::write(
            client, response.data() + written, response.size() - written);
        if (count <= 0) break;
        written += static_cast<size_t>(count);
      }
      ::close(client);
    }
  });
}

std::string UfoCefHandler::HandleControlCommandOnUi(
    const std::string& command) {
  CEF_REQUIRE_UI_THREAD();
  if (command == "show") {
    ShowMainWindow();
    return "ok";
  }
  if (command == "hide") {
    HideMainWindow();
    return "ok";
  }
  if (command == "focus") {
    FocusMainWindow();
    return "ok";
  }
  if (command == "close") {
    CloseAllBrowsers(false);
    return "ok";
  }
  if (command == "agent-active-on") {
    SetAgentConnectionActive(true);
    return "ok";
  }
  if (command == "agent-active-off") {
    SetAgentConnectionActive(false);
    return "ok";
  }
  if (command == "status") return "ok";
  if (!command.empty() && command.front() == '{') {
    auto parsed = CefParseJSON(command, JSON_PARSER_RFC);
    auto root = parsed ? parsed->GetDictionary() : nullptr;
    if (!root) return "error invalid-json";
    const auto operation = root->GetString("command").ToString();
    if (operation == "create-space") {
      if (!main_overview_ready_) return "error overview-not-ready";
      return shared_space_factory_ ? shared_space_factory_(command)
                                   : "error shared-host-disabled";
    }
    if (operation == "presentation-status") {
      int presented_count = 0;
      auto presented_spaces = CefListValue::Create();
      auto active_spaces = CefListValue::Create();
      auto awake_spaces = CefListValue::Create();
      auto sleeping_spaces = CefListValue::Create();
      auto chrome_toolbar_spaces = CefListValue::Create();
      auto native_chrome_spaces = CefListValue::Create();
      auto native_spaces_button_spaces = CefListValue::Create();
      auto controller_mounted_spaces = CefListValue::Create();
      auto native_close_routed_spaces = CefListValue::Create();
      auto native_close_locked_spaces = CefListValue::Create();
      int chrome_controls_space_id = 0;
      const bool overview_presented =
          main_window_ && !main_window_->IsClosed() &&
          UfoCefWindowIsPresented(main_window_->GetWindowHandle());
      if (overview_presented) presented_count += 1;
      for (const auto& [candidate_id, window] : space_windows_) {
        if (agent_active_spaces_.contains(candidate_id)) {
          active_spaces->SetInt(active_spaces->GetSize(), candidate_id);
        }
        const bool compositor_awake = window && !window->IsClosed() &&
            UfoCefWindowIsCompositorAwake(window->GetWindowHandle());
        auto compositor_list = compositor_awake ? awake_spaces : sleeping_spaces;
        compositor_list->SetInt(compositor_list->GetSize(), candidate_id);
        if (!window || window->IsClosed() ||
            !UfoCefWindowIsPresented(window->GetWindowHandle())) {
          continue;
        }
        if (UfoCefChromeControlsArePresentedForWindow(
                window->GetWindowHandle())) {
          chrome_controls_space_id = candidate_id;
        }
        presented_spaces->SetInt(presented_spaces->GetSize(), candidate_id);
        presented_count += 1;
      }
      for (const auto& [candidate_id, browser] : native_space_browsers_) {
        if (!browser || space_windows_.contains(candidate_id)) continue;
        if (agent_active_spaces_.contains(candidate_id)) {
          active_spaces->SetInt(active_spaces->GetSize(), candidate_id);
        }
        const auto handle = browser->GetHost()->GetWindowHandle();
        const bool compositor_awake = handle &&
            UfoCefWindowIsCompositorAwake(handle);
        auto compositor_list = compositor_awake ? awake_spaces : sleeping_spaces;
        compositor_list->SetInt(compositor_list->GetSize(), candidate_id);
        native_chrome_spaces->SetInt(native_chrome_spaces->GetSize(),
                                     candidate_id);
        if (handle && UfoCefShellControlsArePresentedForWindow(handle)) {
          native_spaces_button_spaces->SetInt(
              native_spaces_button_spaces->GetSize(), candidate_id);
        }
        if (handle && UfoCefNativeSpaceWindowIsCloseRouted(handle)) {
          native_close_routed_spaces->SetInt(
              native_close_routed_spaces->GetSize(), candidate_id);
          if (!UfoCefNativeSpaceWindowIsCloseEnabled(handle)) {
            native_close_locked_spaces->SetInt(
                native_close_locked_spaces->GetSize(), candidate_id);
          }
        }
        if (handle && UfoCefWindowIsMountedInProductController(handle)) {
          controller_mounted_spaces->SetInt(
              controller_mounted_spaces->GetSize(), candidate_id);
        }
        if (!handle || !UfoCefWindowIsPresented(handle)) continue;
        presented_spaces->SetInt(presented_spaces->GetSize(), candidate_id);
        presented_count += 1;
      }
      auto response = CefDictionaryValue::Create();
      response->SetBool("ok", true);
      response->SetInt("visibleSpaceId", visible_space_id_);
      response->SetBool("overviewPresented", overview_presented);
      response->SetInt("presentedWindowCount", presented_count);
      response->SetInt("managedWindowCount",
                       static_cast<int>(space_windows_.size() +
                                        native_space_browsers_.size()) +
                           (main_window_ ? 1 : 0));
      response->SetList("presentedSpaceIds", presented_spaces);
      response->SetList("agentActiveSpaceIds", active_spaces);
      response->SetList("awakeSpaceIds", awake_spaces);
      response->SetList("sleepingSpaceIds", sleeping_spaces);
      for (const int candidate_id : chrome_toolbar_spaces_) {
        chrome_toolbar_spaces->SetInt(chrome_toolbar_spaces->GetSize(),
                                      candidate_id);
      }
      response->SetBool("mainChromeToolbarAttached",
                        main_chrome_toolbar_attached_);
      response->SetList("chromeToolbarSpaceIds", chrome_toolbar_spaces);
      response->SetList("nativeChromeSpaceIds", native_chrome_spaces);
      response->SetList("nativeSpacesButtonSpaceIds",
                        native_spaces_button_spaces);
      response->SetList("controllerMountedSpaceIds",
                        controller_mounted_spaces);
      response->SetList("nativeCloseRoutedSpaceIds",
                        native_close_routed_spaces);
      response->SetList("nativeCloseLockedSpaceIds",
                        native_close_locked_spaces);
      bool overlay_presented = false;
      bool overlay_actions_available = false;
      if (visible_space_id_ > 0) {
        const auto visible = GetSpaceWindowHandle(visible_space_id_);
        overlay_presented = visible &&
            UfoAgentOverlayIsActiveForWindow(visible);
        overlay_actions_available = overlay_presented &&
            UfoAgentOverlayHasActionsForWindow(visible);
      } else if (main_window_ && !main_window_->IsClosed()) {
        overlay_presented = UfoAgentOverlayIsActiveForWindow(
            main_window_->GetWindowHandle());
      }
      response->SetBool("agentOverlayPresented", overlay_presented);
      response->SetBool("agentOverlayActionsAvailable",
                        overlay_actions_available);
      response->SetString(
          "profileDirectory",
          CefCommandLine::GetGlobalCommandLine()
              ->GetSwitchValue("profile-directory"));
      response->SetBool("chromeControlsPresented",
                        chrome_controls_space_id > 0);
      response->SetInt("chromeControlsSpaceId", chrome_controls_space_id);
      auto value = CefValue::Create();
      value->SetDictionary(response);
      return JsonString(value);
    }
    if (operation == "request-main-window-close") {
      if (!main_window_ || main_window_->IsClosed()) {
        return "error main-window-not-found";
      }
      UfoCefRequestProductTermination();
      return "ok";
    }
    if (operation == "chrome-profile-manager-probe") {
      const auto command_line = CefCommandLine::GetGlobalCommandLine();
      if (!command_line->HasSwitch("chrome-profile-manager-probe")) {
        return "error profile-manager-probe-disabled";
      }
      const auto action = root->GetString("action").ToString();
      if (action == "list-contexts") {
        auto response = CefDictionaryValue::Create();
        auto contexts = CefListValue::Create();
        for (const auto& browser : browsers_) {
          if (!browser) continue;
          auto entry = CefDictionaryValue::Create();
          const auto context = browser->GetHost()->GetRequestContext();
          const auto frame = browser->GetMainFrame();
          entry->SetInt("browserId", browser->GetIdentifier());
          entry->SetInt("openerId", browser->GetHost()->GetOpenerIdentifier());
          entry->SetString("url", frame ? frame->GetURL() : CefString());
          entry->SetString("cachePath",
                           context ? context->GetCachePath() : CefString());
          entry->SetBool("global", context && context->IsGlobal());
          const auto owner = browser_spaces_.find(browser->GetIdentifier());
          entry->SetInt("spaceId",
                        owner == browser_spaces_.end() ? 0 : owner->second);
          entry->SetBool("hasWindow", browser->GetHost()->GetWindowHandle());
          contexts->SetDictionary(contexts->GetSize(), entry);
        }
        response->SetBool("ok", true);
        response->SetList("contexts", contexts);
        auto value = CefValue::Create();
        value->SetDictionary(response);
        return JsonString(value);
      }
      const char* command_name = nullptr;
      if (action == "add-profile") command_name = "IDC_ADD_NEW_PROFILE";
      if (action == "manage-profiles") {
        command_name = "IDC_MANAGE_CHROME_PROFILES";
      }
      if (!command_name) return "error unsupported-profile-manager-action";
      const int command_id = cef_id_for_command_id_name(command_name);
      for (const auto& browser : browsers_) {
        if (!browser || command_id <= 0 ||
            !browser->GetHost()->CanExecuteChromeCommand(command_id)) {
          continue;
        }
        browser->GetHost()->ExecuteChromeCommand(
            command_id, CEF_WOD_NEW_FOREGROUND_TAB);
        auto response = CefDictionaryValue::Create();
        response->SetBool("ok", true);
        response->SetString("action", action);
        response->SetInt("browserId", browser->GetIdentifier());
        auto value = CefValue::Create();
        value->SetDictionary(response);
        return JsonString(value);
      }
      return "error profile-manager-command-unavailable";
    }
    const int space_id = root->GetInt("spaceId");
    const auto views_window = space_windows_.find(space_id);
    const auto native_browser = native_space_browsers_.find(space_id);
    const bool has_views_window = views_window != space_windows_.end() &&
        views_window->second && !views_window->second->IsClosed();
    const bool has_native_browser =
        native_browser != native_space_browsers_.end() &&
        native_browser->second;
    if (space_id <= 0 || (!has_views_window && !has_native_browser)) {
      return "error space-not-found";
    }
    if (operation == "list-space-browsers") {
      int primary_browser_id = 0;
      std::vector<CefRefPtr<CefBrowser>> space_browsers;
      {
        std::lock_guard<std::mutex> lock(devtools_targets_mutex_);
        const auto primary = space_browsers_.find(space_id);
        if (primary != space_browsers_.end()) {
          primary_browser_id = primary->second;
        }
        for (const auto& browser : browsers_) {
          const auto owner = browser_spaces_.find(browser->GetIdentifier());
          if (owner != browser_spaces_.end() && owner->second == space_id) {
            space_browsers.push_back(browser);
          }
        }
      }
      auto response = CefDictionaryValue::Create();
      response->SetBool("ok", true);
      response->SetInt("spaceId", space_id);
      auto entries = CefListValue::Create();
      for (const auto& browser : space_browsers) {
        auto entry = CefDictionaryValue::Create();
        const int browser_id = browser->GetIdentifier();
        entry->SetInt("browserId", browser_id);
        entry->SetString("route", "browser:" + std::to_string(browser_id));
        entry->SetBool("primary", browser_id == primary_browser_id);
        const auto frame = browser->GetMainFrame();
        entry->SetString("url", frame ? frame->GetURL() : CefString());
        entries->SetDictionary(entries->GetSize(), entry);
      }
      response->SetList("browsers", entries);
      auto value = CefValue::Create();
      value->SetDictionary(response);
      return JsonString(value);
    }
    if (operation == "create-space-tab") {
      int primary_browser_id = 0;
      {
        std::lock_guard<std::mutex> lock(devtools_targets_mutex_);
        const auto primary = space_browsers_.find(space_id);
        if (primary != space_browsers_.end()) {
          primary_browser_id = primary->second;
        }
      }
      for (const auto& browser : browsers_) {
        if (browser->GetIdentifier() != primary_browser_id) continue;
        const int command_id = cef_id_for_command_id_name("IDC_NEW_TAB");
        if (command_id <= 0 ||
            !browser->GetHost()->CanExecuteChromeCommand(command_id)) {
          return "error new-tab-command-unavailable";
        }
        const auto context = browser->GetHost()->GetRequestContext();
        const auto cache_path = context
            ? context->GetCachePath().ToString()
            : std::string();
        if (!cache_path.empty()) {
          pending_context_browser_spaces_[cache_path].push_back(space_id);
        }
        browser->GetHost()->ExecuteChromeCommand(
            command_id, CEF_WOD_NEW_FOREGROUND_TAB);
        return "ok";
      }
      return "error primary-browser-not-found";
    }
    const auto handle = GetSpaceWindowHandle(space_id);
    if (!handle) return "error space-window-not-ready";
    if (operation == "capture-space-screenshot") {
      const auto format = root->GetString("format").ToString();
      const int quality = root->GetInt("quality");
      char* encoded = UfoCefCaptureWindowImageBase64(
          handle, format.empty() ? "png" : format.c_str(), quality);
      if (!encoded) return "error native-screenshot-failed";
      std::string response = "{\"ok\":true,\"data\":\"";
      response += encoded;
      response += "\"}";
      std::free(encoded);
      return response;
    }
    if (operation == "show-space") {
      if (auto spec = native_space_specs_.find(space_id);
          spec != native_space_specs_.end()) spec->second.visible = true;
      SetSpaceCompositorAwake(space_id, true);
      if (has_views_window) views_window->second->Show();
      else {
        UfoCefShellControlsSet(handle, presentation_socket_.c_str());
        UfoCefNativeSpaceWindowSet(
            handle, space_id, presentation_socket_.c_str(),
            agent_active_spaces_.contains(space_id));
      }
      UfoCefWindowSetPresented(handle, true);
      SetVisibleSpace(space_id);
      return "ok";
    }
    if (operation == "hide-space") {
      if (auto spec = native_space_specs_.find(space_id);
          spec != native_space_specs_.end()) spec->second.visible = false;
      UfoCefWindowSetPresented(handle, false);
      if (visible_space_id_ == space_id) SetVisibleSpace(0);
      SetSpaceCompositorAwake(space_id, false);
      return "ok";
    }
    if (operation == "focus-space") {
      if (auto spec = native_space_specs_.find(space_id);
          spec != native_space_specs_.end()) spec->second.visible = true;
      SetSpaceCompositorAwake(space_id, true);
      if (has_views_window) {
        views_window->second->Show();
        views_window->second->Activate();
        views_window->second->BringToTop();
      } else {
        UfoCefShellControlsSet(handle, presentation_socket_.c_str());
        UfoCefNativeSpaceWindowSet(
            handle, space_id, presentation_socket_.c_str(),
            agent_active_spaces_.contains(space_id));
        native_browser->second->GetHost()->SetFocus(true);
      }
      UfoCefWindowSetPresented(handle, true);
      UfoCefWindowFocus(handle);
      SetVisibleSpace(space_id);
      return "ok";
    }
    if (operation == "close-space") {
      agent_active_spaces_.erase(space_id);
      closing_spaces_.insert(space_id);
      if (visible_space_id_ == space_id) SetVisibleSpace(0);
      if (has_views_window) {
        views_window->second->Close();
      } else {
        FlushNativeSpaceCookiesAndClose(space_id);
      }
      return "ok";
    }
    if (operation == "request-window-close-space") {
      if (has_views_window) {
        views_window->second->Close();
      } else if (!IsSpaceAgentConnectionActive(space_id)) {
        UfoCefRequestSpaceClose(space_id, presentation_socket_.c_str());
      }
      return "ok";
    }
    if (operation == "agent-active-space-on") {
      SetSpaceAgentConnectionActive(space_id, true);
      return "ok";
    }
    if (operation == "agent-active-space-off") {
      SetSpaceAgentConnectionActive(space_id, false);
      return "ok";
    }
    if (operation == "agent-overlay-state") {
      auto title = root->GetString("title").ToString();
      auto detail = root->GetString("detail").ToString();
      if (title.empty()) {
        const auto spec = native_space_specs_.find(space_id);
        title = spec != native_space_specs_.end()
            ? spec->second.space_name
            : "Browser Agent";
      }
      if (detail.empty()) detail = "Agent 正在控制";
      agent_task_titles_[space_id] = title;
      agent_task_details_[space_id] = detail;
      if (visible_space_id_ == space_id &&
          agent_active_spaces_.contains(space_id)) {
        UfoAgentOverlayUpdateTask(handle, title.c_str(), detail.c_str());
      }
      return "ok";
    }
    if (operation == "agent-pointer-space") {
      if (visible_space_id_ == space_id &&
          agent_active_spaces_.contains(space_id)) {
        const double x = root->GetDouble("x");
        const double y = root->GetDouble("y");
        auto label = root->GetString("label").ToString();
        if (label.empty()) label = "正在浏览网页";
        UfoAgentOverlayShowPointer(handle, x, y, label.c_str());
      }
      return "ok";
    }
    if (operation == "status-space") return "ok";
    if (operation == "wake-space") {
      SetSpaceCompositorAwake(space_id, true);
      return "ok";
    }
    if (operation == "sleep-space") {
      SetSpaceCompositorAwake(space_id, false);
      return "ok";
    }
  }
  return "error unknown-command";
}

void UfoCefHandler::StartDevToolsSocket(const std::string& path) {
  if (path.empty() || devtools_running_) return;
  devtools_socket_path_ = path;
  ::unlink(path.c_str());
  devtools_socket_fd_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (devtools_socket_fd_ < 0) return;
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  if (path.size() >= sizeof(address.sun_path)) {
    ::close(devtools_socket_fd_);
    devtools_socket_fd_ = -1;
    return;
  }
  std::strncpy(address.sun_path, path.c_str(), sizeof(address.sun_path) - 1);
  if (::bind(devtools_socket_fd_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0 ||
      ::listen(devtools_socket_fd_, 8) != 0) {
    ::close(devtools_socket_fd_);
    devtools_socket_fd_ = -1;
    return;
  }
  devtools_running_ = true;
  devtools_accept_thread_ = std::thread([this]() {
    while (devtools_running_) {
      const int fd = ::accept(devtools_socket_fd_, nullptr, nullptr);
      if (fd < 0) {
        if (devtools_running_) continue;
        break;
      }
      auto client = std::make_shared<DevToolsClient>(fd);
      client->route_id = "client-" +
          std::to_string(next_devtools_client_id_.fetch_add(1));
      {
        std::lock_guard<std::mutex> lock(devtools_clients_mutex_);
        devtools_clients_.push_back(client);
      }
      // Keep the worker joinable. StopDevToolsSocket() closes the client fds
      // and joins all workers before the handler can be destroyed.
      devtools_client_threads_.emplace_back(
          [this, client]() { HandleDevToolsClient(client); });
    }
  });
}

void UfoCefHandler::HandleDevToolsClient(const std::shared_ptr<DevToolsClient>& client) {
  std::string buffer;
  char chunk[4096];
  while (devtools_running_) {
    const ssize_t count = ::read(client->fd, chunk, sizeof(chunk));
    if (count <= 0) break;
    buffer.append(chunk, static_cast<size_t>(count));
    size_t newline = 0;
    while ((newline = buffer.find('\n')) != std::string::npos) {
      const std::string line = buffer.substr(0, newline);
      buffer.erase(0, newline + 1);
      if (line.empty()) continue;
      auto parsed = CefParseJSON(line, JSON_PARSER_RFC);
      if (!parsed || !parsed->GetDictionary()) continue;
      auto dictionary = parsed->GetDictionary();
      const std::string target_id = dictionary->GetString("targetId").ToString();
      const std::string browser_route =
          dictionary->GetString("browserRoute").ToString();
      const std::string method = dictionary->GetString("method").ToString();
      if (method.empty() || target_id.empty()) continue;
      client->target_id = target_id;
      client->browser_route = browser_route;
      DispatchDevToolsMessage(client, dictionary, target_id, browser_route,
                              method);
    }
  }
  // Remove the logical client before closing its fd. Otherwise macOS may
  // immediately reuse the descriptor for the control socket while the stale
  // DevToolsClient is still present, causing CDP JSON to be written into an
  // unrelated control response.
  {
    std::lock_guard<std::mutex> lock(devtools_clients_mutex_);
    devtools_clients_.erase(
        std::remove(devtools_clients_.begin(), devtools_clients_.end(), client),
        devtools_clients_.end());
  }
  const auto route_id = client->route_id;
  // The worker is joined during shutdown, but the UI task may execute later.
  // Retain the ref-counted handler until that task has run.
  CefRefPtr<UfoCefHandler> self(this);
  CefPostTask(TID_UI, base::BindOnce(
      &UfoCefHandler::RemoveDevToolsRoute, std::move(self), route_id));
  ::shutdown(client->fd, SHUT_RDWR);
  ::close(client->fd);
  client->fd = -1;
}

void UfoCefHandler::RemoveDevToolsRoute(const std::string& route_id) {
  CEF_REQUIRE_UI_THREAD();
  devtools_registrations_.erase(route_id);
  std::lock_guard<std::mutex> lock(devtools_clients_mutex_);
  devtools_outer_results_.erase(route_id);
}

void UfoCefHandler::DispatchDevToolsMessage(
    const std::shared_ptr<DevToolsClient>& client,
    CefRefPtr<CefDictionaryValue> message,
    const std::string& target_id,
    const std::string& browser_route,
    const std::string& method) {
  CefRefPtr<UfoCefHandler> self(this);
  CefPostTask(TID_UI, base::BindOnce(
      [](CefRefPtr<UfoCefHandler> handler,
         std::shared_ptr<DevToolsClient> client,
         CefRefPtr<CefDictionaryValue> message, std::string target_id,
         std::string browser_route, std::string method) {
        int message_id = message->GetInt("id");
        if (message_id <= 0 && message->HasKey("id")) {
          message_id = static_cast<int>(message->GetDouble("id"));
        }
        if (method == "Browser.getVersion" && message_id > 0) {
          // CEF 151's Chrome Runtime exposes internal top-chrome renderers in
          // the same CefBrowser. Forwarding this process-level command via
          // SendDevToolsMessage can bind to that internal frame and stall the
          // browser-info handshake. Version discovery is host metadata, so
          // answer it directly without touching a renderer.
          const std::string response =
              std::string("{\"id\":") + std::to_string(message_id) +
              ",\"result\":{\"protocolVersion\":\"1.3\","
              "\"product\":\"Chromium/151\",\"revision\":\"\","
              "\"userAgent\":\"UFO-Browser\",\"jsVersion\":\"\"}}\n";
          std::lock_guard<std::mutex> write_lock(client->write_mutex);
          if (client->fd >= 0) {
            ::write(client->fd, response.data(), response.size());
          }
          return;
        }
        auto browser = handler->FindDevToolsBrowser(target_id, browser_route);
        if (!browser) {
          LOG(ERROR) << "Private DevTools target not found: " << target_id
                     << " route=" << browser_route;
          const int message_id = message->GetInt("id");
          if (message_id > 0) {
            handler->PublishDevToolsMessage(
                client->route_id,
                std::string("{\"id\":") + std::to_string(message_id) +
                    ",\"error\":{\"message\":\"Native CEF browser route is not ready\"}}");
          }
          return;
        }
        if (method == "Browser.setDownloadBehavior") {
          const auto params = message->GetDictionary("params");
          const auto behavior = params
              ? params->GetString("behavior").ToString()
              : std::string();
          const auto download_path = params
              ? params->GetString("downloadPath").ToString()
              : std::string();
          std::lock_guard<std::mutex> lock(handler->devtools_targets_mutex_);
          if ((behavior == "allow" || behavior == "allowAndName") &&
              !download_path.empty()) {
            handler->browser_download_dirs_[browser->GetIdentifier()] =
                download_path;
            const auto context = browser->GetHost()->GetRequestContext();
            const auto cache_path = context
                ? context->GetCachePath().ToString()
                : std::string();
            if (!cache_path.empty()) {
              handler->context_download_dirs_[cache_path] = download_path;
            }
          } else if (behavior == "deny" || behavior == "default") {
            handler->browser_download_dirs_.erase(browser->GetIdentifier());
            const auto context = browser->GetHost()->GetRequestContext();
            const auto cache_path = context
                ? context->GetCachePath().ToString()
                : std::string();
            if (!cache_path.empty()) {
              handler->context_download_dirs_.erase(cache_path);
            }
          }
        }
        if (method == "Target.createTarget" &&
            browser_route.rfind("space:", 0) == 0) {
          const int space_id = std::atoi(browser_route.c_str() + 6);
          const auto context = browser->GetHost()->GetRequestContext();
          const auto cache_path = context
              ? context->GetCachePath().ToString()
              : std::string();
          if (space_id > 0 && !cache_path.empty()) {
            handler->pending_context_browser_spaces_[cache_path].push_back(
                space_id);
          }
        }
        auto observer = CefRefPtr<UfoDevToolsObserver>(
            new UfoDevToolsObserver(handler, client->route_id));
        if (!handler->devtools_registrations_.contains(client->route_id)) {
          handler->devtools_registrations_[client->route_id] =
              browser->GetHost()->AddDevToolsMessageObserver(observer);
        }
        // Remove the bridge-only targetId field before passing the message to
        // Chromium. The remaining JSON is byte-compatible CDP, including
        // deeply nested params that should not be rebuilt field by field.
        auto forwarded = CefDictionaryValue::Create();
        CefDictionaryValue::KeyList keys;
        message->GetKeys(keys);
        // CEF's browser-level DevTools endpoint understands the standard
        // flattened Target session envelope. Forward the sessionId directly
        // instead of wrapping page commands in Target.sendMessageToTarget.
        // The latter is a legacy, non-flattened route and Chrome Runtime 151
        // accepts the outer acknowledgement but never delivers the nested
        // page result, which makes Runtime/Page commands hang indefinitely.
        for (const auto& key : keys) {
          if (key == "targetId" || key == "browserRoute") continue;
          forwarded->SetValue(key, message->GetValue(key));
        }
        auto root = CefValue::Create();
        root->SetDictionary(forwarded);
        const auto encoded = JsonString(root);
        browser->GetHost()->SendDevToolsMessage(encoded.data(), encoded.size());
        LOG(INFO) << "Private DevTools method " << method << " target=" << target_id;
      }, std::move(self), client, message, target_id, browser_route,
      method));
}

CefRefPtr<CefBrowser> UfoCefHandler::FindDevToolsBrowser(
    const std::string& target_id,
    const std::string& browser_route) {
  CEF_REQUIRE_UI_THREAD();
  if (browser_route.rfind("browser:", 0) == 0) {
    const int routed_identifier = std::atoi(browser_route.c_str() + 8);
    for (const auto& browser : browsers_) {
      if (browser->GetIdentifier() == routed_identifier) return browser;
    }
    return nullptr;
  }
  if (browser_route.rfind("space:", 0) == 0) {
    const int space_id = std::atoi(browser_route.c_str() + 6);
    int browser_id = 0;
    {
      std::lock_guard<std::mutex> lock(devtools_targets_mutex_);
      const auto it = space_browsers_.find(space_id);
      if (it != space_browsers_.end()) browser_id = it->second;
    }
    if (browser_id <= 0) return nullptr;
    for (const auto& browser : browsers_) {
      if (browser->GetIdentifier() == browser_id) return browser;
    }
    return nullptr;
  }
  if (browser_route == "browser" && !browsers_.empty()) {
    if (main_overview_browser_id_ > 0) {
      for (const auto& browser : browsers_) {
        if (browser->GetIdentifier() == main_overview_browser_id_) {
          return browser;
        }
      }
    }
    return browsers_.front();
  }
  if (target_id == "browser" && !browsers_.empty()) {
    if (main_overview_browser_id_ > 0) {
      for (const auto& browser : browsers_) {
        if (browser->GetIdentifier() == main_overview_browser_id_) {
          return browser;
        }
      }
    }
    return browsers_.front();
  }
  const int identifier = std::atoi(target_id.c_str());
  for (const auto& browser : browsers_) {
    if (browser->GetIdentifier() == identifier) return browser;
  }
  // A CEF Chrome Runtime process normally owns one top-level browser. Target
  // IDs returned by Target.getTargets are DevTools UUIDs rather than CEF
  // identifiers; route them to that process-local browser when no numeric
  // mapping is available. Multi-browser routing is added without changing the
  // socket protocol in the next lifecycle pass.
  if (browsers_.size() == 1) return browsers_.front();
  return nullptr;
}

void UfoCefHandler::PublishDevToolsMessage(const std::string& route_id,
                                           const std::string& message) {
  std::lock_guard<std::mutex> lock(devtools_clients_mutex_);
  const std::string framed = message + "\n";
  for (const auto& client : devtools_clients_) {
    if (client->route_id != route_id) continue;
    std::lock_guard<std::mutex> write_lock(client->write_mutex);
    if (client->fd >= 0) ::write(client->fd, framed.data(), framed.size());
  }
}

int UfoCefHandler::GetBrowserSpaceId(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  if (!browser) return 0;
  std::lock_guard<std::mutex> lock(devtools_targets_mutex_);
  const auto it = browser_spaces_.find(browser->GetIdentifier());
  return it == browser_spaces_.end() ? 0 : it->second;
}

bool UfoCefHandler::ConsumeDevToolsOuterResult(const std::string& route_id, int id) {
  std::lock_guard<std::mutex> lock(devtools_clients_mutex_);
  auto it = devtools_outer_results_.find(route_id);
  if (it == devtools_outer_results_.end()) return false;
  const bool found = it->second.erase(id) > 0;
  if (it->second.empty()) devtools_outer_results_.erase(it);
  return found;
}

void UfoCefHandler::StopDevToolsSocket() {
  devtools_running_ = false;
  if (devtools_socket_fd_ >= 0) {
    ::shutdown(devtools_socket_fd_, SHUT_RDWR);
    ::close(devtools_socket_fd_);
    devtools_socket_fd_ = -1;
  }
  if (devtools_accept_thread_.joinable()) devtools_accept_thread_.join();
  {
    std::lock_guard<std::mutex> lock(devtools_clients_mutex_);
    for (const auto& client : devtools_clients_) {
      if (client->fd >= 0) {
        ::shutdown(client->fd, SHUT_RDWR);
        ::close(client->fd);
        client->fd = -1;
      }
    }
  }
  for (auto& worker : devtools_client_threads_) {
    if (worker.joinable()) worker.join();
  }
  devtools_client_threads_.clear();
  {
    std::lock_guard<std::mutex> lock(devtools_clients_mutex_);
    devtools_clients_.clear();
  }
  if (!devtools_socket_path_.empty()) ::unlink(devtools_socket_path_.c_str());
}

void UfoCefHandler::StopControlSocket() {
  const bool was_running = control_running_.exchange(false);
  if (control_socket_fd_ >= 0) {
    ::shutdown(control_socket_fd_, SHUT_RDWR);
    ::close(control_socket_fd_);
    control_socket_fd_ = -1;
  }
  if (control_thread_.joinable()) control_thread_.join();
  if (was_running && !control_socket_path_.empty()) ::unlink(control_socket_path_.c_str());
}
