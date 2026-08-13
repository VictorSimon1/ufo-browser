#import <Cocoa/Cocoa.h>

#include <signal.h>

@class UfoNativeLauncherDelegate;
static UfoNativeLauncherDelegate* gLauncherDelegate;

static void HandleTerminationSignal(int signalNumber) {
  (void)signalNumber;
  dispatch_async(dispatch_get_main_queue(), ^{
    [NSApp terminate:nil];
  });
}

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

- (instancetype)init {
  self = [super init];
  if (self) gLauncherDelegate = self;
  return self;
}

- (void)dealloc {
  if (gLauncherDelegate == self) gLauncherDelegate = nil;
}

- (void)applicationDidFinishLaunching:(NSNotification*)notification {
  (void)notification;
  NSString* node = ResourcePath(@"node");
  NSString* script = ResourcePath(@"native-cef-application.js");
  NSString* agent = ResourcePath(@"native-cef-agent.js");
  NSString* storageWorker = ResourcePath(@"profile-sync-storage-revision-worker.js");
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
  environment[@"UFO_BROWSER_NATIVE_STORAGE_REVISION_WORKER"] = storageWorker;
  environment[@"UFO_BROWSER_NATIVE_KEYCHAIN_HELPER"] = keychain;
  environment[@"UFO_BROWSER_NATIVE_RENDERER_ROOT"] = ResourcePath(@"renderer");
  environment[@"UFO_BROWSER_NATIVE_WORKING_DIR"] = [NSBundle mainBundle].bundlePath;

  NSTask* task = [[NSTask alloc] init];
  task.launchPath = node;
  task.arguments = @[script];
  task.currentDirectoryPath = [NSBundle mainBundle].bundlePath;
  task.environment = environment;
  // Forward the coordinator's diagnostics to the native app's stderr. This is
  // important for relocated .app bundles: a failed resource lookup must be
  // visible to the installer smoke test and to Console.app instead of looking
  // like a silent clean exit.
  task.standardOutput = [NSFileHandle fileHandleWithStandardOutput];
  task.standardError = [NSFileHandle fileHandleWithStandardError];
  fprintf(stderr, "[UFO Native launcher] node=%s script=%s cwd=%s\\n",
          node.fileSystemRepresentation, script.fileSystemRepresentation,
          task.currentDirectoryPath.fileSystemRepresentation);
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
  if (self.childTask && self.childTask.isRunning) {
    [self.childTask terminate];
    // Give the Node coordinator a bounded grace period to stop CEF hosts and
    // their GPU/Renderer helpers before the outer App exits. Without this,
    // SIGTERM can orphan the native Chromium process tree.
    NSDate* deadline = [NSDate dateWithTimeIntervalSinceNow:2.0];
    while (self.childTask.isRunning && [deadline timeIntervalSinceNow] > 0) {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                               beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    if (self.childTask.isRunning) [self.childTask interrupt];
  }
  return NSTerminateNow;
}

@end

int main(int argc, const char* argv[]) {
  @autoreleasepool {
    signal(SIGTERM, HandleTerminationSignal);
    signal(SIGINT, HandleTerminationSignal);
    NSApplication* app = NSApplication.sharedApplication;
    UfoNativeLauncherDelegate* delegate = [UfoNativeLauncherDelegate new];
    app.delegate = delegate;
    [app run];
  }
  return 0;
}
