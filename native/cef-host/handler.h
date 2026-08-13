#pragma once

#include <list>

#include "include/cef_client.h"

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
  bool IsClosing() const { return closing_; }

 private:
  using BrowserList = std::list<CefRefPtr<CefBrowser>>;

  BrowserList browsers_;
  bool closing_ = false;

  IMPLEMENT_REFCOUNTING(UfoCefHandler);
};
