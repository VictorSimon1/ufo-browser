#import <Cocoa/Cocoa.h>

#include <unistd.h>
#include <signal.h>

static NSString* ResourcePath(NSString* name) {
  return [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:name];
}

@interface UfoNativeLauncherDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic) pid_t childPid;
@end

@implementation UfoNativeLauncherDelegate

- (void)applicationDidFinishLaunching:(NSNotification*)notification {
  (void)notification;
  NSString* node = ResourcePath(@"node");
  NSString* script = ResourcePath(@"native-cef-application.js");
  NSString* agent = ResourcePath(@"native-cef-agent.js");
  NSString* host = ResourcePath(@"ufo-cef-host");
  NSString* keychain = ResourcePath(@"ufo-keychain-helper");
  NSString* userData = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/UFO-Browser-Native"];
  pid_t pid = fork();
  if (pid == 0) {
    setenv("UFO_CEF_HOST", host.UTF8String, 1);
    setenv("UFO_BROWSER_NATIVE_USER_DATA", userData.UTF8String, 1);
    setenv("UFO_BROWSER_NATIVE_AGENT_SCRIPT", agent.UTF8String, 1);
    setenv("UFO_BROWSER_NATIVE_KEYCHAIN_HELPER", keychain.UTF8String, 1);
    execl(node.UTF8String, node.UTF8String, script.UTF8String, (char*)nullptr);
    _exit(127);
  }
  self.childPid = pid;
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication*)sender {
  (void)sender;
  if (self.childPid > 0) kill(self.childPid, SIGTERM);
  return NSTerminateNow;
}

@end

int main(int argc, const char* argv[]) {
  @autoreleasepool {
    NSApplication* app = NSApplication.sharedApplication;
    UfoNativeLauncherDelegate* delegate = [UfoNativeLauncherDelegate new];
    app.delegate = delegate;
    [app run];
  }
  return 0;
}
