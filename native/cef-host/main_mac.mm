#import <Cocoa/Cocoa.h>

#include <signal.h>

#include <atomic>
#include <chrono>
#include <cerrno>
#include <cstdlib>
#include <filesystem>
#include <fcntl.h>
#include <string>
#include <thread>
#include <unistd.h>

#include "include/cef_application_mac.h"
#include "include/cef_command_line.h"
#include "include/base/cef_callback.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/wrapper/cef_library_loader.h"
#include "native/cef-host/app.h"
#include "native/cef-host/handler.h"
#include "native/cef-host/overlay_mac.h"

@interface UfoCefApplication : NSApplication <CefAppProtocol>
@end

static volatile sig_atomic_t g_termination_requested = 0;
static int g_signal_pipe[2] = {-1, -1};
static std::thread g_signal_thread;
static std::atomic<bool> g_signal_thread_stop{false};

static void HandleTerminationSignal(int signal_number) {
  (void)signal_number;
  if (g_termination_requested) return;
  g_termination_requested = 1;
  // Only write to a self-pipe here. This is async-signal-safe; the normal
  // worker thread below performs the CEF task posting and browser teardown.
  if (g_signal_pipe[1] >= 0) {
    const char marker = 'T';
    (void)write(g_signal_pipe[1], &marker, sizeof(marker));
  }
}

static bool CreateSignalPipe() {
  if (pipe(g_signal_pipe) != 0) return false;
  fcntl(g_signal_pipe[0], F_SETFD, FD_CLOEXEC);
  fcntl(g_signal_pipe[1], F_SETFD, FD_CLOEXEC);
  return true;
}

static void StartSignalPump() {
  g_signal_thread_stop.store(false);
  g_signal_thread = std::thread([] {
    char marker = 0;
    while (!g_signal_thread_stop.load() &&
           read(g_signal_pipe[0], &marker, sizeof(marker)) == sizeof(marker)) {
      if (marker == 'Q') break;
      if (marker != 'T') continue;
      CefPostTask(TID_UI, base::BindOnce([] {
        if (auto* handler = UfoCefHandler::GetInstance()) {
          handler->CloseAllBrowsers(true);
        } else {
          _exit(0);
        }
      }));
      // The Chrome Views runtime can be waiting on a renderer/browser-info
      // callback while a SIGTERM is already tearing down the helper tree. Do
      // not let that callback hold the host forever: give the normal close
      // task a short grace period, then use the process-group shutdown path.
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      // The launcher sends SIGTERM to the complete detached process group, so
      // helpers have already received the same bounded shutdown signal. If the
      // Chrome Views loop is still blocked after the grace period, exiting the
      // host here prevents a renderer/GPU leak from keeping the group alive.
      _exit(0);
      break;
    }
  });
}

static void StopSignalPump() {
  g_signal_thread_stop.store(true);
  if (g_signal_pipe[1] >= 0) {
    const char marker = 'Q';
    (void)write(g_signal_pipe[1], &marker, sizeof(marker));
  }
  if (g_signal_thread.joinable()) g_signal_thread.join();
  if (g_signal_pipe[0] >= 0) close(g_signal_pipe[0]);
  if (g_signal_pipe[1] >= 0) close(g_signal_pipe[1]);
  g_signal_pipe[0] = -1;
  g_signal_pipe[1] = -1;
}

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
      // The AppKit overlay owns the only two explicit human actions available
      // while an Agent controls the Space. Deliver events to that transparent
      // panel; its full-size view swallows everything outside the control
      // capsule and routes only takeover/termination through UFO state.
      if (UfoAgentOverlayOwnsWindow(event.window)) {
        [super sendEvent:event];
        return;
      }
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
  // SIGTERM is the bounded shutdown path used by the Native launcher and
  // test harness. Do not wait for page beforeunload/Views close negotiation
  // here: the outer App has already decided to terminate, so force the CEF
  // browser tree closed and let OnBeforeClose quit the message loop.
  if (handler && !handler->IsClosing()) handler->CloseAllBrowsers(true);
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
    if (!CreateSignalPipe()) return 1;
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
      StopSignalPump();
      return CefGetExitCode();
    }

    // Install after CefInitialize. Chromium may configure its own signal
    // dispositions during initialization, so installing earlier can be
    // silently overwritten and leave the host running after SIGTERM.
    signal(SIGTERM, HandleTerminationSignal);
    signal(SIGINT, HandleTerminationSignal);
    StartSignalPump();

    UfoCefAppDelegate* delegate = [[UfoCefAppDelegate alloc] init];
    NSApp.delegate = delegate;
    CefRunMessageLoop();
    StopSignalPump();
    CefShutdown();
    delegate = nil;
  }
  return 0;
}
