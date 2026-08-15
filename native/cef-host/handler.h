#pragma once

#include <atomic>
#include <deque>
#include <functional>
#include <list>
#include <map>
#include <set>
#include <string>
#include <thread>
#include <memory>
#include <mutex>
#include <vector>

#include "include/cef_client.h"
#include "include/cef_download_handler.h"
#include "include/views/cef_window.h"

class UfoCefHandler final : public CefClient,
                            public CefDisplayHandler,
                            public CefDownloadHandler,
                            public CefLifeSpanHandler,
                            public CefLoadHandler {
 public:
  explicit UfoCefHandler(bool chrome_style);
  ~UfoCefHandler() override;

  static UfoCefHandler* GetInstance();

  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefDownloadHandler> GetDownloadHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }

  void OnTitleChange(CefRefPtr<CefBrowser> browser,
                     const CefString& title) override;
  bool OnBeforeDownload(CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefDownloadItem> download_item,
                        const CefString& suggested_name,
                        CefRefPtr<CefBeforeDownloadCallback> callback) override;
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override;
  bool DoClose(CefRefPtr<CefBrowser> browser) override;
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override;
  void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                CefRefPtr<CefFrame> frame,
                int http_status_code) override;

  void CloseAllBrowsers(bool force_close);
  void RequestApplicationClose(bool force_close);
  void OnApplicationCookieStoreFlushed();
  void OnSpaceCookieStoreFlushed(int space_id);
  void ShowMainWindow();
  void HideMainWindow();
  void FocusMainWindow();
  void SetMainWindow(CefRefPtr<CefWindow> window);
  void RegisterBrowserSpace(CefRefPtr<CefBrowser> browser, int space_id);
  void RegisterPopupBrowser(CefRefPtr<CefBrowser> parent,
                            CefRefPtr<CefBrowser> popup);
  void RegisterSpaceWindow(int space_id, CefRefPtr<CefWindow> window);
  void RegisterPendingNativeSpace(const std::string& cache_path,
                                  int space_id,
                                  bool visible,
                                  std::string url,
                                  std::string space_name,
                                  std::string profile_name);
  void CancelPendingNativeSpace(const std::string& cache_path, int space_id);
  void SetMainChromeToolbarAttached(bool attached);
  void SetSpaceChromeToolbarAttached(int space_id, bool attached);
  void SetPresentationSocket(std::string path);
  void SetSharedSpaceFactory(
      std::function<std::string(const std::string&)> factory);
  void SetAgentConnectionActive(bool active);
  void SetSpaceAgentConnectionActive(int space_id, bool active);
  bool IsAgentConnectionActive() const { return agent_active_; }
  bool IsSpaceAgentConnectionActive(int space_id) const;
  bool IsSpaceCloseAuthorized(int space_id) const;
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
  bool main_overview_ready_ = false;
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
  // Client sockets are closed during shutdown, but their worker threads must
  // also be joined before the handler is destroyed.  A detached worker can
  // otherwise post a UI callback with a dangling UfoCefHandler pointer.
  std::vector<std::thread> devtools_client_threads_;
  std::mutex devtools_clients_mutex_;
  std::vector<std::shared_ptr<DevToolsClient>> devtools_clients_;
  std::map<std::string, CefRefPtr<CefRegistration>> devtools_registrations_;
  std::map<std::string, std::set<int>> devtools_outer_results_;
  std::map<std::string, int> devtools_target_browsers_;
  std::map<int, int> browser_spaces_;
  std::map<int, int> space_browsers_;
  std::map<int, std::string> browser_download_dirs_;
  std::map<std::string, std::string> context_download_dirs_;
  std::map<int, CefRefPtr<CefWindow>> space_windows_;
  struct PendingNativeSpace {
    int space_id = 0;
    bool visible = false;
    std::string url;
    std::string space_name;
    std::string profile_name;
  };
  std::map<std::string, std::deque<PendingNativeSpace>> pending_native_spaces_;
  std::map<std::string, std::deque<int>> pending_context_browser_spaces_;
  std::map<std::string, std::set<int>> native_context_spaces_;
  std::map<int, CefRefPtr<CefBrowser>> native_space_browsers_;
  std::map<int, std::string> native_space_contexts_;
  std::map<int, PendingNativeSpace> native_space_specs_;
  bool main_chrome_toolbar_attached_ = false;
  std::set<int> chrome_toolbar_spaces_;
  std::set<int> agent_active_spaces_;
  std::map<int, std::string> agent_task_titles_;
  std::map<int, std::string> agent_task_details_;
  std::set<int> closing_spaces_;
  std::set<int> space_cookie_flushes_;
  int pending_application_cookie_flushes_ = 0;
  bool application_cookie_flush_force_close_ = false;
  int visible_space_id_ = 0;
  std::string presentation_socket_;
  std::function<std::string(const std::string&)> shared_space_factory_;
  std::mutex devtools_targets_mutex_;
  std::atomic<uint64_t> next_devtools_client_id_{1};

  void HandleDevToolsClient(const std::shared_ptr<DevToolsClient>& client);
  void FlushCookieStoresAndCloseBrowsers(bool force_close);
  void FlushNativeSpaceCookiesAndClose(int space_id);
  void FinishNativeSpaceClose(int space_id);
  void RemoveDevToolsRoute(const std::string& route_id);
  void DispatchDevToolsMessage(const std::shared_ptr<DevToolsClient>& client,
                               CefRefPtr<CefDictionaryValue> message,
                               const std::string& target_id,
                               const std::string& browser_route,
                               const std::string& method);
  CefRefPtr<CefBrowser> FindDevToolsBrowser(const std::string& target_id,
                                            const std::string& browser_route);
  int GetBrowserSpaceId(CefRefPtr<CefBrowser> browser);
  std::string HandleControlCommandOnUi(const std::string& command);
  void SetVisibleSpace(int space_id);
  void SetSpaceCompositorAwake(int space_id, bool awake);
  void ConfigureNativeSpaceWindow(int space_id, int attempt = 0);
  CefWindowHandle GetSpaceWindowHandle(int space_id) const;

  IMPLEMENT_REFCOUNTING(UfoCefHandler);
};
