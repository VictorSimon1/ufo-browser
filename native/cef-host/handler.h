#pragma once

#include <atomic>
#include <list>
#include <map>
#include <set>
#include <string>
#include <thread>
#include <memory>
#include <mutex>
#include <vector>

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
  void SetAgentConnectionActive(bool active);
  bool IsAgentConnectionActive() const { return agent_active_; }
  void StartControlSocket(const std::string& path);
  void StopControlSocket();
  void StartDevToolsSocket(const std::string& path);
  void StopDevToolsSocket();
  void PublishDevToolsMessage(const std::string& target_id,
                              const std::string& message);
  bool ConsumeDevToolsOuterResult(const std::string& route_id, int id);
  bool IsClosing() const { return closing_; }
  bool IsChromeStyle() const { return chrome_style_; }

 private:
  using BrowserList = std::list<CefRefPtr<CefBrowser>>;

  BrowserList browsers_;
  CefRefPtr<CefWindow> main_window_;
  const bool chrome_style_;
  bool closing_ = false;
  std::atomic<bool> agent_active_{false};
  std::string control_socket_path_;
  int control_socket_fd_ = -1;
  std::atomic<bool> control_running_{false};
  std::thread control_thread_;

  struct DevToolsClient;
  std::string devtools_socket_path_;
  int devtools_socket_fd_ = -1;
  std::atomic<bool> devtools_running_{false};
  std::thread devtools_accept_thread_;
  std::mutex devtools_clients_mutex_;
  std::vector<std::shared_ptr<DevToolsClient>> devtools_clients_;
  std::map<std::string, CefRefPtr<CefRegistration>> devtools_registrations_;
  std::map<std::string, std::set<int>> devtools_outer_results_;
  std::map<std::string, int> devtools_target_browsers_;
  std::mutex devtools_targets_mutex_;

  void HandleDevToolsClient(const std::shared_ptr<DevToolsClient>& client);
  void DispatchDevToolsMessage(const std::shared_ptr<DevToolsClient>& client,
                               CefRefPtr<CefDictionaryValue> message,
                               const std::string& target_id,
                               const std::string& browser_route,
                               const std::string& method);
  CefRefPtr<CefBrowser> FindDevToolsBrowser(const std::string& target_id,
                                            const std::string& browser_route);

  IMPLEMENT_REFCOUNTING(UfoCefHandler);
};
