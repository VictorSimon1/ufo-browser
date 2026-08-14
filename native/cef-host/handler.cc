#include "native/cef-host/handler.h"

#include <algorithm>
#include <cstring>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <sstream>
#include <utility>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "include/cef_app.h"
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
  UfoDevToolsObserver(UfoCefHandler* handler, std::string route_id)
      : handler_(handler), route_id_(std::move(route_id)) {}

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
  UfoCefHandler* handler_;
  const std::string route_id_;
  IMPLEMENT_REFCOUNTING(UfoDevToolsObserver);
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
  const auto target_id = std::to_string(browser->GetIdentifier());
  std::lock_guard<std::mutex> lock(devtools_targets_mutex_);
  devtools_target_browsers_[target_id] = browser->GetIdentifier();
  const int opener_id = browser->GetHost()->GetOpenerIdentifier();
  if (opener_id > 0) {
    const auto opener_space = browser_spaces_.find(opener_id);
    if (opener_space != browser_spaces_.end()) {
      browser_spaces_[browser->GetIdentifier()] = opener_space->second;
      // Keep the Space route pinned to its primary Browser. A popup belongs
      // to the same logical Space, but must not replace the Browser-level CDP
      // endpoint used to enumerate and create targets for that Space.
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
  {
    std::lock_guard<std::mutex> lock(devtools_targets_mutex_);
    devtools_target_browsers_.erase(std::to_string(browser->GetIdentifier()));
    browser_download_dirs_.erase(browser->GetIdentifier());
    const auto space_it = browser_spaces_.find(browser->GetIdentifier());
    if (space_it != browser_spaces_.end()) {
      const auto primary_it = space_browsers_.find(space_it->second);
      if (primary_it != space_browsers_.end() &&
          primary_it->second == browser->GetIdentifier()) {
        space_browsers_.erase(primary_it);
      }
      browser_spaces_.erase(space_it);
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
    if (space_id > 0) {
      frame->ExecuteJavaScript(
          std::string("globalThis.__ufoSpaceId=") +
              std::to_string(space_id) + ";",
          frame->GetURL(), 0);
    }
    LOG(INFO) << "UFO native Chrome loaded " << frame->GetURL().ToString()
              << " status=" << http_status_code;
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

void UfoCefHandler::ShowMainWindow() {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(&UfoCefHandler::ShowMainWindow, this));
    return;
  }
  if (main_window_ && !main_window_->IsClosed()) main_window_->Show();
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
  }
}

void UfoCefHandler::FocusMainWindow() {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(&UfoCefHandler::FocusMainWindow, this));
    return;
  }
  if (main_window_ && !main_window_->IsClosed()) {
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
    }
    main_window_ = nullptr;
    return;
  }
  main_window_ = window;
  if (agent_active_ && main_window_) {
    UfoAgentOverlaySet(main_window_->GetWindowHandle(), true,
                       "Agent controlling", 0, nullptr);
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
  if (window) space_windows_[space_id] = window;
  else space_windows_.erase(space_id);
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
                       "Agent controlling", 0, nullptr);
  }
  else UfoAgentOverlayClear(main_window_->GetWindowHandle());
}

void UfoCefHandler::SetSpaceAgentConnectionActive(int space_id, bool active) {
  CEF_REQUIRE_UI_THREAD();
  if (space_id <= 0) return;
  if (active) agent_active_spaces_.insert(space_id);
  else agent_active_spaces_.erase(space_id);
  if (visible_space_id_ == space_id) SetVisibleSpace(space_id);
}

void UfoCefHandler::SetVisibleSpace(int space_id) {
  CEF_REQUIRE_UI_THREAD();
  if (visible_space_id_ > 0) {
    const auto previous = space_windows_.find(visible_space_id_);
    if (previous != space_windows_.end() && previous->second &&
        !previous->second->IsClosed()) {
      UfoAgentOverlayClear(previous->second->GetWindowHandle());
    }
  }
  visible_space_id_ = space_id;
  const bool active = space_id > 0 && agent_active_spaces_.contains(space_id);
  agent_active_ = active;
  if (!active) return;
  const auto current = space_windows_.find(space_id);
  if (current != space_windows_.end() && current->second &&
      !current->second->IsClosed()) {
    UfoAgentOverlaySet(current->second->GetWindowHandle(), true,
                       "Agent controlling", space_id,
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
      ::write(client, response.data(), response.size());
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
      return shared_space_factory_ ? shared_space_factory_(command)
                                   : "error shared-host-disabled";
    }
    if (operation == "presentation-status") {
      int presented_count = 0;
      auto presented_spaces = CefListValue::Create();
      auto active_spaces = CefListValue::Create();
      int chrome_controls_space_id = 0;
      const bool overview_presented =
          main_window_ && !main_window_->IsClosed() &&
          UfoCefWindowIsPresented(main_window_->GetWindowHandle());
      if (overview_presented) presented_count += 1;
      for (const auto& [candidate_id, window] : space_windows_) {
        if (agent_active_spaces_.contains(candidate_id)) {
          active_spaces->SetInt(active_spaces->GetSize(), candidate_id);
        }
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
      auto response = CefDictionaryValue::Create();
      response->SetBool("ok", true);
      response->SetInt("visibleSpaceId", visible_space_id_);
      response->SetBool("overviewPresented", overview_presented);
      response->SetInt("presentedWindowCount", presented_count);
      response->SetInt("managedWindowCount",
                       static_cast<int>(space_windows_.size()) +
                           (main_window_ ? 1 : 0));
      response->SetList("presentedSpaceIds", presented_spaces);
      response->SetList("agentActiveSpaceIds", active_spaces);
      bool overlay_presented = false;
      bool overlay_actions_available = false;
      if (visible_space_id_ > 0) {
        const auto visible = space_windows_.find(visible_space_id_);
        overlay_presented = visible != space_windows_.end() && visible->second &&
            !visible->second->IsClosed() &&
            UfoAgentOverlayIsActiveForWindow(
                visible->second->GetWindowHandle());
        overlay_actions_available = overlay_presented &&
            UfoAgentOverlayHasActionsForWindow(
                visible->second->GetWindowHandle());
      } else if (main_window_ && !main_window_->IsClosed()) {
        overlay_presented = UfoAgentOverlayIsActiveForWindow(
            main_window_->GetWindowHandle());
      }
      response->SetBool("agentOverlayPresented", overlay_presented);
      response->SetBool("agentOverlayActionsAvailable",
                        overlay_actions_available);
      response->SetBool("chromeControlsPresented",
                        chrome_controls_space_id > 0);
      response->SetInt("chromeControlsSpaceId", chrome_controls_space_id);
      auto value = CefValue::Create();
      value->SetDictionary(response);
      return JsonString(value);
    }
    const int space_id = root->GetInt("spaceId");
    const auto it = space_windows_.find(space_id);
    if (space_id <= 0 || it == space_windows_.end() || !it->second ||
        it->second->IsClosed()) {
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
        browser->GetHost()->ExecuteChromeCommand(
            command_id, CEF_WOD_NEW_FOREGROUND_TAB);
        return "ok";
      }
      return "error primary-browser-not-found";
    }
    auto window = it->second;
    if (operation == "show-space") {
      window->Show();
      UfoCefWindowSetPresented(window->GetWindowHandle(), true);
      SetVisibleSpace(space_id);
      return "ok";
    }
    if (operation == "hide-space") {
      UfoCefWindowSetPresented(window->GetWindowHandle(), false);
      if (visible_space_id_ == space_id) SetVisibleSpace(0);
      return "ok";
    }
    if (operation == "focus-space") {
      window->Show();
      UfoCefWindowSetPresented(window->GetWindowHandle(), true);
      window->Activate();
      window->BringToTop();
      SetVisibleSpace(space_id);
      return "ok";
    }
    if (operation == "close-space") {
      agent_active_spaces_.erase(space_id);
      if (visible_space_id_ == space_id) SetVisibleSpace(0);
      window->Close();
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
    if (operation == "status-space") return "ok";
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
      std::thread([this, client]() { HandleDevToolsClient(client); }).detach();
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
  CefPostTask(TID_UI, base::BindOnce(
      &UfoCefHandler::RemoveDevToolsRoute, this, route_id));
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
  CefPostTask(TID_UI, base::BindOnce(
      [](UfoCefHandler* handler, std::shared_ptr<DevToolsClient> client,
         CefRefPtr<CefDictionaryValue> message, std::string target_id,
         std::string browser_route, std::string method) {
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
      }, base::Unretained(this), client, message, target_id, browser_route,
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
    return browsers_.front();
  }
  if (target_id == "browser" && !browsers_.empty()) return browsers_.front();
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
  std::lock_guard<std::mutex> lock(devtools_clients_mutex_);
  for (const auto& client : devtools_clients_) {
    ::shutdown(client->fd, SHUT_RDWR);
    ::close(client->fd);
  }
  devtools_clients_.clear();
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
