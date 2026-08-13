#include "native/cef-host/handler.h"

#include <cstring>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "include/cef_app.h"
#include "include/base/cef_callback.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/wrapper/cef_helpers.h"

namespace {
UfoCefHandler* g_instance = nullptr;
}

UfoCefHandler::UfoCefHandler(bool chrome_style)
    {
  (void)chrome_style;
  DCHECK(!g_instance);
  g_instance = this;
}

UfoCefHandler::~UfoCefHandler() {
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

void UfoCefHandler::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  browsers_.push_back(browser);
}

bool UfoCefHandler::DoClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  if (browsers_.size() == 1) closing_ = true;
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
}

void UfoCefHandler::HideMainWindow() {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(&UfoCefHandler::HideMainWindow, this));
    return;
  }
  if (main_window_ && !main_window_->IsClosed()) main_window_->Hide();
}

void UfoCefHandler::FocusMainWindow() {
  if (!CefCurrentlyOn(TID_UI)) {
    CefPostTask(TID_UI, base::BindOnce(&UfoCefHandler::FocusMainWindow, this));
    return;
  }
  if (main_window_ && !main_window_->IsClosed()) {
    main_window_->Show();
    main_window_->Activate();
    main_window_->BringToTop();
  }
}

void UfoCefHandler::SetMainWindow(CefRefPtr<CefWindow> window) {
  CEF_REQUIRE_UI_THREAD();
  main_window_ = window;
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
      char buffer[256]{};
      const ssize_t count = ::read(client, buffer, sizeof(buffer) - 1);
      const std::string command(buffer, count > 0 ? static_cast<size_t>(count) : 0);
      std::string response = "ok\n";
      if (command.rfind("show", 0) == 0) {
        CefPostTask(TID_UI, base::BindOnce(&UfoCefHandler::ShowMainWindow, this));
      } else if (command.rfind("hide", 0) == 0) {
        CefPostTask(TID_UI, base::BindOnce(&UfoCefHandler::HideMainWindow, this));
      } else if (command.rfind("focus", 0) == 0) {
        CefPostTask(TID_UI, base::BindOnce(&UfoCefHandler::FocusMainWindow, this));
      } else if (command.rfind("close", 0) == 0) {
        CefPostTask(TID_UI, base::BindOnce(&UfoCefHandler::CloseAllBrowsers, this, false));
      } else if (command.rfind("status", 0) != 0) {
        response = "error unknown-command\n";
      }
      ::write(client, response.data(), response.size());
      ::close(client);
    }
  });
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
