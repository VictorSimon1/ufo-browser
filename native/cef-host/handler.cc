#include "native/cef-host/handler.h"

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
  if (browsers_.empty()) CefQuitMessageLoop();
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
  if (browsers_.empty()) return;
  auto browser_view = CefBrowserView::GetForBrowser(browsers_.front());
  auto window = browser_view ? browser_view->GetWindow() : nullptr;
  if (window) window->Show();
}
