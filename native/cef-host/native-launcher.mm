#import <Cocoa/Cocoa.h>

static NSString* ResourcePath(NSString* name) {
  return [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:name];
}

static NSString* HostExecutablePath() {
  // The CEF host must remain in Contents/MacOS so its @rpath resolves to the
  // app's Contents/Frameworks directory after a DMG drag-install.
  return [[NSBundle mainBundle].bundlePath stringByAppendingPathComponent:@"Contents/MacOS/ufo-cef-host"];
}

@interface UfoNativeLauncherDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSTask* childTask;
@property(nonatomic) BOOL terminating;
@end

@implementation UfoNativeLauncherDelegate

- (void)applicationDidFinishLaunching:(NSNotification*)notification {
  (void)notification;
  NSString* node = ResourcePath(@"node");
  NSString* script = ResourcePath(@"native-cef-application.js");
  NSString* agent = ResourcePath(@"native-cef-agent.js");
  NSString* host = HostExecutablePath();
  NSString* keychain = ResourcePath(@"ufo-keychain-helper");
  // Keep imported Profiles, browser state, and the standard CLI socket on the
  // same data root when Native CEF replaces the Electron shell.
  NSString* userData = NSProcessInfo.processInfo.environment[@"UFO_BROWSER_NATIVE_USER_DATA"];
  if (!userData.length) {
    userData = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/UFO-Browser"];
  }
  NSMutableDictionary* environment =
      [[[NSProcessInfo processInfo] environment] mutableCopy];
  environment[@"UFO_CEF_HOST"] = host;
  environment[@"UFO_BROWSER_NATIVE_USER_DATA"] = userData;
  environment[@"UFO_BROWSER_NATIVE_AGENT_SCRIPT"] = agent;
  environment[@"UFO_BROWSER_NATIVE_KEYCHAIN_HELPER"] = keychain;

  NSTask* task = [[NSTask alloc] init];
  task.launchPath = node;
  task.arguments = @[script];
  task.currentDirectoryPath = [NSBundle mainBundle].bundlePath;
  task.environment = environment;
  __weak UfoNativeLauncherDelegate* weakSelf = self;
  task.terminationHandler = ^(NSTask* terminatedTask) {
    (void)terminatedTask;
    dispatch_async(dispatch_get_main_queue(), ^{
      UfoNativeLauncherDelegate* strongSelf = weakSelf;
      if (!strongSelf || strongSelf.terminating) return;
      // The Native coordinator owns the Overview and Agent lifecycle. If it
      // stops (including a user closing the Overview window), terminate the
      // outer App too so a later launch starts cleanly instead of leaving a
      // blank shell behind.
      strongSelf.terminating = YES;
      [NSApp terminate:nil];
    });
  };
  self.childTask = task;
  NSError* launchError = nil;
  if (![task launchAndReturnError:&launchError]) {
    NSLog(@"UFO Native launcher failed to start Agent: %@", launchError);
    self.terminating = YES;
    [NSApp terminate:nil];
  }
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication*)sender {
  (void)sender;
  self.terminating = YES;
  if (self.childTask && self.childTask.isRunning) [self.childTask terminate];
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
