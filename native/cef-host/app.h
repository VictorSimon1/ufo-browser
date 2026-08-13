#pragma once

#include "include/cef_app.h"

class UfoCefApp final : public CefApp, public CefBrowserProcessHandler {
 public:
  UfoCefApp() = default;

  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }

  void OnContextInitialized() override;
  CefRefPtr<CefClient> GetDefaultClient() override;

 private:
  IMPLEMENT_REFCOUNTING(UfoCefApp);
};

