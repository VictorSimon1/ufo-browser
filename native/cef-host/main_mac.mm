#import <Cocoa/Cocoa.h>

#include <cerrno>
#include <cstdlib>

#include "include/cef_application_mac.h"
#include "include/cef_command_line.h"
#include "include/wrapper/cef_library_loader.h"
#include "native/cef-host/app.h"
#include "native/cef-host/handler.h"

@interface UfoCefApplication : NSApplication <CefAppProtocol>
@end

@implementation UfoCefApplication
- (BOOL)isHandlingSendEvent { return NO; }
- (void)setHandlingSendEvent:(BOOL)handlingSendEvent {}
- (void)sendEvent:(NSEvent*)event {
  CefScopedSendingEvent sendingEventScoper;
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

