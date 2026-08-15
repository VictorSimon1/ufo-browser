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
static NSTask* g_agent_task = nil;
static bool g_stopping_agent = false;

static NSString* UfoResourcePath(NSString* name) {
  return [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:name];
}

static bool IsPackagedUfoProduct() {
  return [[NSFileManager defaultManager] isExecutableFileAtPath:UfoResourcePath(@"node")] &&
      [[NSFileManager defaultManager] fileExistsAtPath:UfoResourcePath(@"native-cef-agent.js")];
}

static NSString* EnvironmentValue(NSString* name, NSString* fallback) {
  NSString* value = NSProcessInfo.processInfo.environment[name];
  return value.length ? value : fallback;
}

static bool StartPackagedAgentService() {
  if (!IsPackagedUfoProduct()) return true;

  NSFileManager* files = NSFileManager.defaultManager;
  NSString* user_data = EnvironmentValue(
      @"UFO_BROWSER_NATIVE_USER_DATA",
      [NSHomeDirectory() stringByAppendingPathComponent:
          @"Library/Application Support/UFO-Browser"]);
  NSString* runtime_root = [NSTemporaryDirectory()
      stringByAppendingPathComponent:[NSString stringWithFormat:
          @"ufo-browser-native-%d", getpid()]];
  NSString* control_root = [runtime_root stringByAppendingPathComponent:@"control"];
  NSString* devtools_root = [runtime_root stringByAppendingPathComponent:@"devtools"];
  NSString* overview_control = [control_root stringByAppendingPathComponent:@"overview.sock"];
  NSString* presentation = [control_root stringByAppendingPathComponent:@"presentation.sock"];
  NSString* devtools = [devtools_root stringByAppendingPathComponent:@"shared-host.sock"];
  NSString* info_file = [user_data stringByAppendingPathComponent:@"overview.json"];
  NSString* agent_socket = [user_data stringByAppendingPathComponent:@"ufo-browser.sock"];
  NSError* directory_error = nil;
  [files createDirectoryAtPath:user_data
   withIntermediateDirectories:YES
                    attributes:@{NSFilePosixPermissions: @0700}
                         error:&directory_error];
  [files createDirectoryAtPath:control_root
   withIntermediateDirectories:YES
                    attributes:@{NSFilePosixPermissions: @0700}
                         error:&directory_error];
  [files createDirectoryAtPath:devtools_root
   withIntermediateDirectories:YES
                    attributes:@{NSFilePosixPermissions: @0700}
                         error:&directory_error];
  if (directory_error) {
    NSLog(@"UFO failed to prepare its native runtime: %@", directory_error);
    return false;
  }
  [files removeItemAtPath:info_file error:nil];

  NSMutableDictionary* environment =
      [[[NSProcessInfo processInfo] environment] mutableCopy];
  environment[@"UFO_BROWSER_NATIVE_ATTACHED_HOST"] = @"1";
  environment[@"UFO_BROWSER_NATIVE_HOST_PID"] =
      [NSString stringWithFormat:@"%d", getpid()];
  environment[@"UFO_BROWSER_NATIVE_SHARED_HOST"] = @"1";
  environment[@"UFO_BROWSER_NATIVE_OVERVIEW_MODE"] = @"external";
  environment[@"UFO_BROWSER_NATIVE_USER_DATA"] = user_data;
  environment[@"UFO_BROWSER_SOCKET"] = agent_socket;
  environment[@"UFO_BROWSER_OVERVIEW_INFO_FILE"] = info_file;
  environment[@"UFO_BROWSER_CONTROL_SOCKETS"] = control_root;
  environment[@"UFO_BROWSER_OVERVIEW_CONTROL_SOCKET"] = overview_control;
  environment[@"UFO_BROWSER_PRESENTATION_SOCKET"] = presentation;
  environment[@"UFO_BROWSER_DEVTOOLS_SOCKETS_ROOT"] = devtools_root;
  environment[@"UFO_BROWSER_SHARED_HOST_DEVTOOLS_SOCKET"] = devtools;
  environment[@"UFO_BROWSER_NATIVE_STORAGE_REVISION_WORKER"] =
      UfoResourcePath(@"profile-sync-storage-revision-worker.js");
  environment[@"UFO_BROWSER_NATIVE_KEYCHAIN_HELPER"] =
      UfoResourcePath(@"ufo-keychain-helper");
  environment[@"UFO_BROWSER_NATIVE_RENDERER_ROOT"] = UfoResourcePath(@"renderer");
  environment[@"UFO_BROWSER_NATIVE_WORKING_DIR"] = NSBundle.mainBundle.bundlePath;
  environment[@"UFO_CEF_HOST"] = NSBundle.mainBundle.executablePath;

  NSTask* task = [[NSTask alloc] init];
  task.launchPath = UfoResourcePath(@"node");
  task.arguments = @[UfoResourcePath(@"native-cef-agent.js")];
  task.currentDirectoryPath = NSBundle.mainBundle.bundlePath;
  task.environment = environment;
  [environment release];
  task.standardOutput = [NSFileHandle fileHandleWithStandardOutput];
  task.standardError = [NSFileHandle fileHandleWithStandardError];
  NSError* launch_error = nil;
  if (![task launchAndReturnError:&launch_error]) {
    NSLog(@"UFO failed to start its Agent service: %@", launch_error);
    [task release];
    return false;
  }
  g_agent_task = task;
  task.terminationHandler = ^(NSTask* finished) {
    (void)finished;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (g_stopping_agent || g_termination_requested) return;
      if (auto* handler = UfoCefHandler::GetInstance()) {
        handler->RequestApplicationClose(true);
      } else {
        [NSApp terminate:nil];
      }
    });
  };

  NSDate* deadline = [NSDate dateWithTimeIntervalSinceNow:15.0];
  NSString* overview_url = nil;
  while ([deadline timeIntervalSinceNow] > 0 && task.isRunning) {
    NSData* data = [NSData dataWithContentsOfFile:info_file];
    if (data.length) {
      NSDictionary* info = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
      NSString* candidate = [info isKindOfClass:NSDictionary.class] ? info[@"url"] : nil;
      if ([candidate isKindOfClass:NSString.class] &&
          [candidate hasPrefix:@"http://127.0.0.1:"]) {
        overview_url = candidate;
        break;
      }
    }
    [NSThread sleepForTimeInterval:0.05];
  }
  if (!overview_url.length) {
    NSLog(@"UFO Agent service did not publish the Overview URL");
    g_stopping_agent = true;
    if (task.isRunning) [task terminate];
    [task release];
    g_agent_task = nil;
    g_stopping_agent = false;
    return false;
  }

  setenv("UFO_BROWSER_NATIVE_ATTACHED_HOST", "1", 1);
  setenv("UFO_BROWSER_ATTACHED_OVERVIEW_URL", overview_url.UTF8String, 1);
  setenv("UFO_BROWSER_NATIVE_USER_DATA", user_data.UTF8String, 1);
  setenv("UFO_BROWSER_OVERVIEW_CONTROL_SOCKET", overview_control.UTF8String, 1);
  setenv("UFO_BROWSER_PRESENTATION_SOCKET", presentation.UTF8String, 1);
  setenv("UFO_BROWSER_SHARED_HOST_DEVTOOLS_SOCKET", devtools.UTF8String, 1);
  return true;
}

static void StopPackagedAgentService() {
  NSTask* task = g_agent_task;
  if (!task) return;
  g_agent_task = nil;
  g_stopping_agent = true;
  if (task.isRunning) {
    [task terminate];
    NSDate* deadline = [NSDate dateWithTimeIntervalSinceNow:2.0];
    while (task.isRunning && [deadline timeIntervalSinceNow] > 0) {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                               beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    if (task.isRunning) [task interrupt];
  }
  [task release];
  g_stopping_agent = false;
}

void UfoCefRequestProductTermination() {
  // Chrome Runtime can keep its message loop alive after its last native
  // window is closed. Use the same bounded shutdown path as SIGTERM so the
  // browser, managed Agent, and Chromium helpers leave as one product tree.
  if (g_agent_task && g_agent_task.isRunning) [g_agent_task terminate];
  raise(SIGTERM);
}

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
          handler->RequestApplicationClose(true);
        } else {
          _exit(0);
        }
      }));
      // Give Chromium's normal browser/context shutdown enough time to flush
      // cookies, storage and profile metadata. StopSignalPump marks the loop
      // complete as soon as CefRunMessageLoop returns. Only use _exit as the
      // final bounded fallback for a genuinely wedged Chrome callback.
      for (int attempt = 0;
           attempt < 40 && !g_signal_thread_stop.load();
           attempt += 1) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
      }
      if (!g_signal_thread_stop.load()) _exit(0);
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
      if (UfoAgentOverlayOwnsWindow(event.window) ||
          UfoCefChromeControlsOwnWindow(event.window)) {
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
  if (handler && !handler->IsClosing()) handler->RequestApplicationClose(true);
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
    const bool profile_window_request =
        command_line->HasSwitch("ufo-profile-window-request");
    if (!profile_window_request && !StartPackagedAgentService()) {
      StopSignalPump();
      return 1;
    }

    CefSettings settings;
    settings.no_sandbox = true;
    NSString* helper_executable = [NSBundle.mainBundle.bundlePath
        stringByAppendingPathComponent:
            @"Contents/Frameworks/ufo-cef-host Helper.app/Contents/MacOS/ufo-cef-host Helper"];
    if ([NSFileManager.defaultManager isExecutableFileAtPath:helper_executable]) {
      CefString(&settings.browser_subprocess_path) = helper_executable.UTF8String;
    }
    auto user_data_dir = command_line->GetSwitchValue("user-data-dir");
    if (user_data_dir.empty()) {
      const char* attached_user_data = std::getenv("UFO_BROWSER_NATIVE_USER_DATA");
      if (attached_user_data && *attached_user_data) user_data_dir = attached_user_data;
    }
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
      StopPackagedAgentService();
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
    StopPackagedAgentService();
    delegate = nil;
  }
  return 0;
}
