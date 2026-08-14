#import <Cocoa/Cocoa.h>

#include <cerrno>
#include <cstdlib>
#include <filesystem>
#include <string>

#include "include/cef_application_mac.h"
#include "include/cef_command_line.h"
#include "include/wrapper/cef_library_loader.h"
#include "native/cef-host/app.h"
#include "native/cef-host/handler.h"

@interface UfoCefApplication : NSApplication <CefAppProtocol>
@end

namespace {

// Agent control blocks human interaction with the page and CEF toolbar, but
// the native window itself must remain movable. Track only a drag that began
// outside the CEF content view (the actual macOS titlebar). This keeps the
// browser page fully protected while preserving the normal Chrome/AppKit
// window affordance requested for controlled Spaces.
__unsafe_unretained NSWindow* g_titlebar_drag_window = nil;

BOOL IsNativeTitlebarPoint(NSWindow* window, NSPoint screen_point) {
  if (!window || !window.contentView) return NO;
  NSRect content_in_window = [window.contentView convertRect:window.contentView.bounds
                                                        toView:nil];
  NSRect content = [window convertRectToScreen:content_in_window];
  if (!NSPointInRect(screen_point, content)) return YES;

  // Unified titlebar configurations can make contentView extend into the
  // titlebar. Keep a narrow top strip as a fallback, but never classify the
  // CEF page/toolbar area below it as draggable.
  NSRect frame = window.frame;
  const CGFloat titlebarHeight = 32.0;
  return screen_point.y >= NSMaxY(frame) - titlebarHeight;
}

BOOL IsTitlebarDragEvent(NSEvent* event) {
  NSWindow* window = event.window;
  if (!window) return NO;
  NSPoint screen_point = [window convertPointToScreen:event.locationInWindow];
  if (event.type == NSEventTypeLeftMouseDown) {
    if (!IsNativeTitlebarPoint(window, screen_point)) return NO;
    g_titlebar_drag_window = window;
    return YES;
  }
  if (event.type == NSEventTypeLeftMouseDragged) {
    return g_titlebar_drag_window == window;
  }
  if (event.type == NSEventTypeLeftMouseUp) {
    const BOOL was_dragging = g_titlebar_drag_window == window;
    if (was_dragging) g_titlebar_drag_window = nil;
    return was_dragging;
  }
  return NO;
}

}  // namespace

@implementation UfoCefApplication
- (BOOL)isHandlingSendEvent { return NO; }
- (void)setHandlingSendEvent:(BOOL)handlingSendEvent {}
- (void)sendEvent:(NSEvent*)event {
  CefScopedSendingEvent sendingEventScoper;
  UfoCefHandler* handler = UfoCefHandler::GetInstance();
  if (handler && handler->IsAgentConnectionActive()) {
    NSEventType type = event.type;
    const BOOL humanInput = type == NSEventTypeLeftMouseDown ||
                            type == NSEventTypeLeftMouseUp ||
                            type == NSEventTypeRightMouseDown ||
                            type == NSEventTypeRightMouseUp ||
                            type == NSEventTypeOtherMouseDown ||
                            type == NSEventTypeOtherMouseUp ||
                            type == NSEventTypeMouseMoved ||
                            type == NSEventTypeLeftMouseDragged ||
                            type == NSEventTypeRightMouseDragged ||
                            type == NSEventTypeOtherMouseDragged ||
                            type == NSEventTypeScrollWheel ||
                            type == NSEventTypeKeyDown ||
                            type == NSEventTypeKeyUp ||
                            type == NSEventTypeFlagsChanged;
    // Agent input arrives over CEF DevTools and never enters NSApplication's
    // event queue. Swallowing these events blocks the human without covering
    // the CEF surface, so screenshots and CDP clicks remain pixel-accurate.
    if (humanInput) {
      // A controlled Space remains draggable from the native titlebar. Do not
      // broaden this to the CEF toolbar or page: those must stay blocked.
      if (IsTitlebarDragEvent(event)) {
        [super sendEvent:event];
      }
      return;
    }
  }
  [super sendEvent:event];
}
- (void)terminate:(id)sender {
  UfoCefHandler* handler = UfoCefHandler::GetInstance();
  if (handler && !handler->IsClosing()) handler->CloseAllBrowsers(false);
}
@end

@interface UfoCefAppDelegate : NSObject <NSApplicationDelegate>
@end

@implementation UfoCefAppDelegate
- (BOOL)applicationShouldHandleReopen:(NSApplication*)application
                    hasVisibleWindows:(BOOL)flag {
  UfoCefHandler* handler = UfoCefHandler::GetInstance();
  if (handler && !handler->IsClosing()) handler->ShowMainWindow();
  return NO;
}
- (BOOL)applicationSupportsSecureRestorableState:(NSApplication*)app {
  return YES;
}
@end

static void ConfigureDevelopmentDevTools(CefRefPtr<CefCommandLine> command_line,
                                          CefSettings* settings) {
  if (command_line->HasSwitch("devtools-socket")) return;
  if (!command_line->HasSwitch("agent-devtools-port")) return;
  const auto value = command_line->GetSwitchValue("agent-devtools-port");
  char* end = nullptr;
  const long port = std::strtol(value.ToString().c_str(), &end, 10);
  if (!end || *end != '\0' || port < 0 || port > 65535) {
    NSLog(@"Ignoring invalid --agent-devtools-port=%s", value.ToString().c_str());
    return;
  }
  // Development-only transport. Production uses the private Agent socket.
  if (port == 0 || port >= 1024) settings->remote_debugging_port = static_cast<int>(port);
}

int main(int argc, char* argv[]) {
  CefScopedLibraryLoader library_loader;
  if (!library_loader.LoadInMain()) return 1;

  CefMainArgs main_args(argc, argv);
  @autoreleasepool {
    [UfoCefApplication sharedApplication];
    CefRefPtr<CefCommandLine> command_line = CefCommandLine::CreateCommandLine();
    command_line->InitFromArgv(argc, argv);

    CefSettings settings;
    settings.no_sandbox = true;
    const auto user_data_dir = command_line->GetSwitchValue("user-data-dir");
    if (!user_data_dir.empty()) {
      // Chrome-style CEF owns its profile directory. The Node AgentHost passes
      // one directory per native Profile/Space in later integration stages.
      const auto root = std::filesystem::weakly_canonical(
          std::filesystem::path(user_data_dir.ToString()));
      CefString(&settings.root_cache_path) = root.string();
      CefString(&settings.cache_path) = (root / "Cache").string();
    }
    ConfigureDevelopmentDevTools(command_line, &settings);
    CefRefPtr<UfoCefApp> app(new UfoCefApp());
    if (!CefInitialize(main_args, settings, app.get(), nullptr)) {
      return CefGetExitCode();
    }

    UfoCefAppDelegate* delegate = [[UfoCefAppDelegate alloc] init];
    NSApp.delegate = delegate;
    CefRunMessageLoop();
    CefShutdown();
    delegate = nil;
  }
  return 0;
}
