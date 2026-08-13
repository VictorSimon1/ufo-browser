#pragma once

#include <atomic>
#include <list>
#include <string>
#include <thread>

#include "include/cef_client.h"
#include "include/views/cef_window.h"

class UfoCefHandler final : public CefClient,
                            public CefDisplayHandler,
                            public CefLifeSpanHandler,
                            public CefLoadHandler {
 public:
  explicit UfoCefHandler(bool chrome_style);
  ~UfoCefHandler() override;

  static UfoCefHandler* GetInstance();

  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }

  void OnTitleChange(CefRefPtr<CefBrowser> browser,
                     const CefString& title) override;
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override;
  bool DoClose(CefRefPtr<CefBrowser> browser) override;
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override;
  void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                CefRefPtr<CefFrame> frame,
                int http_status_code) override;

  void CloseAllBrowsers(bool force_close);
  void ShowMainWindow();
  void HideMainWindow();
  void FocusMainWindow();
  void SetMainWindow(CefRefPtr<CefWindow> window);
  void StartControlSocket(const std::string& path);
  void StopControlSocket();
  bool IsClosing() const { return closing_; }

 private:
  using BrowserList = std::list<CefRefPtr<CefBrowser>>;

  BrowserList browsers_;
  CefRefPtr<CefWindow> main_window_;
  bool closing_ = false;
  std::string control_socket_path_;
  int control_socket_fd_ = -1;
  std::atomic<bool> control_running_{false};
  std::thread control_thread_;

  IMPLEMENT_REFCOUNTING(UfoCefHandler);
};
