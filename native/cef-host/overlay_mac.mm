#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>

#include <cmath>
#include <cstring>
#include <string>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "native/cef-host/overlay_mac.h"

@interface UfoOverlayView : NSView
@property(nonatomic, copy) NSString* label;
@property(nonatomic, copy) NSString* socketPath;
@property(nonatomic) NSInteger spaceId;
@property(nonatomic, copy) NSString* pressedAction;
@property(nonatomic) CGFloat phase;
@end

static NSRect UfoOverlayCapsuleRect(NSRect bounds) {
  const CGFloat width = MIN(430.0, MAX(360.0, bounds.size.width * 0.34));
  return NSMakeRect((NSWidth(bounds) - width) / 2.0,
                    NSHeight(bounds) - 72.0, width, 44.0);
}

static NSRect UfoOverlayTerminateRect(NSRect capsule) {
  return NSMakeRect(NSMaxX(capsule) - 92.0, NSMinY(capsule) + 6.0, 84.0, 32.0);
}

static NSRect UfoOverlayTakeOverRect(NSRect capsule) {
  const NSRect terminate = UfoOverlayTerminateRect(capsule);
  return NSMakeRect(NSMinX(terminate) - 74.0, NSMinY(terminate), 66.0, 32.0);
}

@implementation UfoOverlayView

- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)canBecomeKeyView { return YES; }
- (BOOL)isOpaque { return NO; }

- (void)drawRect:(NSRect)dirtyRect {
  [super drawRect:dirtyRect];
  const CGFloat scale = self.window.backingScaleFactor ?: 1.0;
  (void)scale;
  NSRect bounds = self.bounds;

  // Transparent everywhere except for a small neutral control capsule. The
  // view itself covers the content area and consumes human input events.
  NSRect capsule = UfoOverlayCapsuleRect(bounds);
  CGFloat pulse = 0.5 + 0.5 * std::sin(self.phase);
  NSColor* fill = [NSColor colorWithCalibratedWhite:0.10 alpha:0.88 - pulse * 0.04];
  NSColor* stroke = [NSColor colorWithCalibratedWhite:1.0 alpha:0.13 + pulse * 0.06];
  NSBezierPath* path = [NSBezierPath bezierPathWithRoundedRect:capsule xRadius:17.0 yRadius:17.0];
  [fill setFill];
  [path fill];
  [stroke setStroke];
  [path setLineWidth:1.0];
  [path stroke];

  NSRect dot = NSMakeRect(NSMinX(capsule) + 14.0,
                          NSMidY(capsule) - 4.0,
                          8.0 + pulse * 1.5,
                          8.0 + pulse * 1.5);
  [[NSColor colorWithCalibratedRed:0.48 green:0.76 blue:1.0 alpha:0.92] setFill];
  [[NSBezierPath bezierPathWithOvalInRect:dot] fill];

  NSDictionary* attrs = @{
    NSFontAttributeName: [NSFont systemFontOfSize:12.0 weight:NSFontWeightMedium],
    NSForegroundColorAttributeName: [NSColor colorWithCalibratedWhite:0.96 alpha:0.94],
  };
  NSString* text = self.label.length ? self.label : @"Agent controlling";
  NSSize textSize = [text sizeWithAttributes:attrs];
  [text drawAtPoint:NSMakePoint(NSMinX(capsule) + 31.0,
                                NSMidY(capsule) - textSize.height / 2.0)
      withAttributes:attrs];

  const NSRect takeOver = UfoOverlayTakeOverRect(capsule);
  const NSRect terminate = UfoOverlayTerminateRect(capsule);
  for (NSString* action in @[@"take-over-space", @"terminate-space"]) {
    const BOOL isTakeOver = [action isEqualToString:@"take-over-space"];
    const NSRect button = isTakeOver ? takeOver : terminate;
    const BOOL pressed = [self.pressedAction isEqualToString:action];
    NSColor* buttonFill = isTakeOver
        ? [NSColor colorWithCalibratedWhite:1.0 alpha:pressed ? 0.20 : 0.11]
        : [NSColor colorWithCalibratedRed:0.72 green:0.20 blue:0.22 alpha:pressed ? 0.90 : 0.72];
    NSBezierPath* buttonPath = [NSBezierPath bezierPathWithRoundedRect:button xRadius:10.0 yRadius:10.0];
    [buttonFill setFill];
    [buttonPath fill];
    NSString* title = isTakeOver ? @"接管" : @"终止任务";
    NSDictionary* buttonAttrs = @{
      NSFontAttributeName: [NSFont systemFontOfSize:11.0 weight:NSFontWeightSemibold],
      NSForegroundColorAttributeName: [NSColor colorWithCalibratedWhite:0.98 alpha:0.96],
    };
    NSSize size = [title sizeWithAttributes:buttonAttrs];
    [title drawAtPoint:NSMakePoint(NSMidX(button) - size.width / 2.0,
                                   NSMidY(button) - size.height / 2.0)
         withAttributes:buttonAttrs];
  }
}

// Swallow all page input while the agent owns the Space, but keep the two
// explicit ownership controls interactive. CEF's DevTools/CDP transport does
// not go through this AppKit event path and remains unaffected.
- (NSString*)actionAtPoint:(NSPoint)point {
  const NSRect capsule = UfoOverlayCapsuleRect(self.bounds);
  if (NSPointInRect(point, UfoOverlayTakeOverRect(capsule))) return @"take-over-space";
  if (NSPointInRect(point, UfoOverlayTerminateRect(capsule))) return @"terminate-space";
  return nil;
}

- (void)mouseDown:(NSEvent*)event {
  self.pressedAction = [self actionAtPoint:[self convertPoint:event.locationInWindow fromView:nil]];
  [self setNeedsDisplayInRect:UfoOverlayCapsuleRect(self.bounds)];
}

- (void)mouseUp:(NSEvent*)event {
  NSString* action = [self actionAtPoint:[self convertPoint:event.locationInWindow fromView:nil]];
  const BOOL shouldSend = action.length && [action isEqualToString:self.pressedAction];
  self.pressedAction = nil;
  [self setNeedsDisplayInRect:UfoOverlayCapsuleRect(self.bounds)];
  if (!shouldSend || self.spaceId <= 0 || !self.socketPath.length) return;
  const char* path = self.socketPath.UTF8String;
  if (!path || std::strlen(path) >= sizeof(sockaddr_un{}.sun_path)) return;
  const int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return;
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::strncpy(address.sun_path, path, sizeof(address.sun_path) - 1);
  if (::connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0) {
    NSString* command = [NSString stringWithFormat:@"{\"command\":\"%@\",\"spaceId\":%ld}\n",
                                                   action, (long)self.spaceId];
    const char* bytes = command.UTF8String;
    if (bytes) (void)::write(fd, bytes, std::strlen(bytes));
  }
  ::close(fd);
}
- (void)mouseDragged:(NSEvent*)event {}
- (void)rightMouseDown:(NSEvent*)event {}
- (void)rightMouseUp:(NSEvent*)event {}
- (void)keyDown:(NSEvent*)event {}
- (void)keyUp:(NSEvent*)event {}
- (void)scrollWheel:(NSEvent*)event {}

@end

@interface UfoOverlayPanel : NSPanel
@property(nonatomic, assign) NSWindow* hostWindow;
@property(nonatomic, strong) UfoOverlayView* overlayView;
@property(nonatomic, strong) NSTimer* pulseTimer;
@end

@implementation UfoOverlayPanel

- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }

@end

@interface UfoShellButtonView : NSView
@property(nonatomic, copy) NSString* socketPath;
@property(nonatomic) BOOL highlighted;
@end

@implementation UfoShellButtonView

- (BOOL)isOpaque { return NO; }
- (BOOL)accessibilityIsIgnored { return NO; }
- (NSAccessibilityRole)accessibilityRole { return NSAccessibilityButtonRole; }
- (NSString*)accessibilityLabel { return @"Spaces"; }

- (void)drawRect:(NSRect)dirtyRect {
  (void)dirtyRect;
  NSRect bounds = NSInsetRect(self.bounds, 1.0, 1.0);
  NSColor* fill = [NSColor colorWithCalibratedWhite:0.12
                                               alpha:self.highlighted ? 0.92 : 0.78];
  NSColor* stroke = [NSColor colorWithCalibratedWhite:1.0
                                                 alpha:self.highlighted ? 0.26 : 0.16];
  NSBezierPath* capsule = [NSBezierPath bezierPathWithRoundedRect:bounds
                                                            xRadius:8.0
                                                            yRadius:8.0];
  [fill setFill];
  [capsule fill];
  [stroke setStroke];
  [capsule setLineWidth:1.0];
  [capsule stroke];

  // Four small squares give the same compact Spaces affordance as a native
  // browser tab/workspace control without drawing any browser chrome in HTML.
  const CGFloat gap = 2.5;
  const CGFloat cell = 5.0;
  const CGFloat total = cell * 2.0 + gap;
  const CGFloat originX = NSMidX(bounds) - total / 2.0;
  const CGFloat originY = NSMidY(bounds) - total / 2.0;
  NSColor* icon = [NSColor colorWithCalibratedWhite:0.94 alpha:0.92];
  [icon setFill];
  for (NSInteger row = 0; row < 2; row += 1) {
    for (NSInteger column = 0; column < 2; column += 1) {
      NSRect cellRect = NSMakeRect(originX + column * (cell + gap),
                                   originY + row * (cell + gap), cell, cell);
      [[NSBezierPath bezierPathWithRoundedRect:cellRect xRadius:1.2 yRadius:1.2] fill];
    }
  }
}

- (void)mouseDown:(NSEvent*)event {
  (void)event;
  self.highlighted = YES;
  [self setNeedsDisplay:YES];
}

- (void)mouseUp:(NSEvent*)event {
  (void)event;
  self.highlighted = NO;
  [self setNeedsDisplay:YES];
  const char* path = self.socketPath.UTF8String;
  if (!path || std::strlen(path) >= sizeof(sockaddr_un{}.sun_path)) return;
  const int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return;
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::strncpy(address.sun_path, path, sizeof(address.sun_path) - 1);
  if (::connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0) {
    static const char command[] = "show-overview\n";
    (void)::write(fd, command, sizeof(command) - 1);
  }
  ::close(fd);
}

@end

@interface UfoShellPanel : NSPanel
@property(nonatomic, assign) NSWindow* hostWindow;
@property(nonatomic, strong) UfoShellButtonView* buttonView;
@end

@implementation UfoShellPanel

- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }

@end

@interface UfoSpaceControllerView : NSView
@property(nonatomic, copy) NSString* spaceName;
@property(nonatomic, copy) NSString* profileName;
@property(nonatomic, copy) NSString* socketPath;
@property(nonatomic) BOOL highlighted;
@end

@implementation UfoSpaceControllerView

- (BOOL)isOpaque { return NO; }
- (BOOL)accessibilityIsIgnored { return NO; }
- (NSAccessibilityRole)accessibilityRole { return NSAccessibilityButtonRole; }
- (NSString*)accessibilityLabel { return @"Return to Spaces"; }

- (void)drawRect:(NSRect)dirtyRect {
  (void)dirtyRect;
  NSRect bounds = NSInsetRect(self.bounds, 1.0, 1.0);
  NSColor* fill = [NSColor colorWithCalibratedWhite:0.10 alpha:self.highlighted ? 0.92 : 0.82];
  NSColor* stroke = [NSColor colorWithCalibratedWhite:1.0 alpha:self.highlighted ? 0.26 : 0.15];
  NSBezierPath* capsule = [NSBezierPath bezierPathWithRoundedRect:bounds xRadius:9.0 yRadius:9.0];
  [fill setFill];
  [capsule fill];
  [stroke setStroke];
  [capsule setLineWidth:1.0];
  [capsule stroke];

  NSBezierPath* chevron = [NSBezierPath bezierPath];
  [chevron moveToPoint:NSMakePoint(13.0, NSMidY(bounds) + 4.0)];
  [chevron lineToPoint:NSMakePoint(9.0, NSMidY(bounds))];
  [chevron lineToPoint:NSMakePoint(13.0, NSMidY(bounds) - 4.0)];
  [[NSColor colorWithCalibratedWhite:0.94 alpha:0.92] setStroke];
  [chevron setLineWidth:1.5];
  [chevron stroke];

  NSDictionary* nameAttrs = @{
    NSFontAttributeName: [NSFont systemFontOfSize:11.0 weight:NSFontWeightSemibold],
    NSForegroundColorAttributeName: [NSColor colorWithCalibratedWhite:0.96 alpha:0.95],
  };
  NSDictionary* profileAttrs = @{
    NSFontAttributeName: [NSFont systemFontOfSize:10.0 weight:NSFontWeightRegular],
    NSForegroundColorAttributeName: [NSColor colorWithCalibratedWhite:0.78 alpha:0.88],
  };
  NSString* name = self.spaceName.length ? self.spaceName : @"Space";
  NSString* profile = self.profileName.length ? self.profileName : @"Default";
  const CGFloat maxNameWidth = MAX(58.0, NSWidth(bounds) - 48.0);
  while (name.length > 4 && [name sizeWithAttributes:nameAttrs].width > maxNameWidth) {
    name = [[name substringToIndex:name.length - 2] stringByAppendingString:@"…"];
  }
  [name drawAtPoint:NSMakePoint(21.0, NSMaxY(bounds) - 16.0) withAttributes:nameAttrs];
  [profile drawAtPoint:NSMakePoint(21.0, NSMinY(bounds) + 4.0) withAttributes:profileAttrs];
}

- (void)mouseDown:(NSEvent*)event {
  (void)event;
  self.highlighted = YES;
  [self setNeedsDisplay:YES];
}

- (void)mouseUp:(NSEvent*)event {
  (void)event;
  self.highlighted = NO;
  [self setNeedsDisplay:YES];
  const char* path = self.socketPath.UTF8String;
  if (!path || std::strlen(path) >= sizeof(sockaddr_un{}.sun_path)) return;
  const int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return;
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::strncpy(address.sun_path, path, sizeof(address.sun_path) - 1);
  if (::connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0) {
    static const char command[] = "show-overview\n";
    (void)::write(fd, command, sizeof(command) - 1);
  }
  ::close(fd);
}

@end

@interface UfoSpaceControllerPanel : NSPanel
@property(nonatomic, assign) NSWindow* hostWindow;
@property(nonatomic, strong) UfoSpaceControllerView* controllerView;
@end

@implementation UfoSpaceControllerPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

@interface UfoChromeControlsMetadata : NSObject
@property(nonatomic, copy) NSString* spaceName;
@property(nonatomic, copy) NSString* profileName;
@property(nonatomic, copy) NSString* socketPath;
@end

@implementation UfoChromeControlsMetadata
@end

static UfoOverlayPanel* gPanel;
static NSWindow* gHostWindow;
static id gMoveObserver;
static id gResizeObserver;
static UfoShellPanel* gShellPanel;
static NSWindow* gShellHostWindow;
static id gShellMoveObserver;
static id gShellResizeObserver;
static UfoSpaceControllerPanel* gSpaceControllerPanel;
static NSWindow* gSpaceControllerHostWindow;
static id gSpaceControllerMoveObserver;
static id gSpaceControllerResizeObserver;
static NSMapTable<NSWindow*, UfoChromeControlsMetadata*>* gChromeControlsMetadata;
static NSMapTable<NSWindow*, NSNumber*>* gCompositorAwakeState;

static NSMapTable<NSWindow*, UfoChromeControlsMetadata*>* ChromeControlsMetadata() {
  if (!gChromeControlsMetadata) {
    gChromeControlsMetadata = [[NSMapTable alloc]
        initWithKeyOptions:NSPointerFunctionsWeakMemory | NSPointerFunctionsObjectPersonality
              valueOptions:NSPointerFunctionsStrongMemory
                  capacity:0];
  }
  return gChromeControlsMetadata;
}

static UfoChromeControlsMetadata* MetadataForHost(NSWindow* host, BOOL create) {
  if (!host) return nil;
  UfoChromeControlsMetadata* metadata = [ChromeControlsMetadata() objectForKey:host];
  if (!metadata && create) {
    metadata = [[[UfoChromeControlsMetadata alloc] init] autorelease];
    [ChromeControlsMetadata() setObject:metadata forKey:host];
  }
  return metadata;
}

static NSMapTable<NSWindow*, NSNumber*>* CompositorAwakeState() {
  if (!gCompositorAwakeState) {
    gCompositorAwakeState = [[NSMapTable alloc]
        initWithKeyOptions:NSPointerFunctionsWeakMemory |
                           NSPointerFunctionsObjectPersonality
              valueOptions:NSPointerFunctionsStrongMemory
                  capacity:0];
  }
  return gCompositorAwakeState;
}

void RemoveOverlay() {
  NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
  if (gMoveObserver) [center removeObserver:gMoveObserver];
  if (gResizeObserver) [center removeObserver:gResizeObserver];
  gMoveObserver = nil;
  gResizeObserver = nil;
  [gPanel.pulseTimer invalidate];
  if (gHostWindow && gPanel) [gHostWindow removeChildWindow:gPanel];
  [gPanel orderOut:nil];
  [gPanel release];
  gPanel = nil;
  [gHostWindow release];
  gHostWindow = nil;
}

void PositionOverlay() {
  if (!gPanel || !gHostWindow) return;
  NSView* content = gHostWindow.contentView;
  if (!content) return;
  NSRect frame = [content convertRect:content.bounds toView:nil];
  frame = [gHostWindow convertRectToScreen:frame];
  [gPanel setFrame:frame display:YES];
}

void PositionShellButton() {
  if (!gShellPanel || !gShellHostWindow) return;
  NSView* content = gShellHostWindow.contentView;
  if (!content) return;
  NSRect frame = [content convertRect:content.bounds toView:nil];
  frame = [gShellHostWindow convertRectToScreen:frame];
  const CGFloat width = 34.0;
  const CGFloat height = 30.0;
  // Leave Chromium's profile/avatar and menu controls unobstructed. The
  // native toolbar reserves roughly the final 90px for those controls.
  const CGFloat rightInset = 98.0;
  const CGFloat topInset = 8.0;
  frame.origin.x = NSMaxX(frame) - rightInset - width;
  frame.origin.y = NSMaxY(frame) - topInset - height;
  frame.size = NSMakeSize(width, height);
  [gShellPanel setFrame:frame display:YES];
}

void RemoveShellControls() {
  NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
  if (gShellMoveObserver) [center removeObserver:gShellMoveObserver];
  if (gShellResizeObserver) [center removeObserver:gShellResizeObserver];
  gShellMoveObserver = nil;
  gShellResizeObserver = nil;
  if (gShellHostWindow && gShellPanel) [gShellHostWindow removeChildWindow:gShellPanel];
  [gShellPanel orderOut:nil];
  [gShellPanel release];
  gShellPanel = nil;
  [gShellHostWindow release];
  gShellHostWindow = nil;
}

void PositionSpaceController() {
  if (!gSpaceControllerPanel || !gSpaceControllerHostWindow) return;
  NSRect frame = gSpaceControllerHostWindow.frame;
  const CGFloat width = MIN(280.0, MAX(190.0, NSWidth(frame) * 0.24));
  const CGFloat height = 30.0;
  // AppKit titlebar placement keeps the UFO controller visible without
  // covering Chromium's native tabs, omnibox, profile, or menu controls.
  frame.origin.x += 174.0;
  frame.origin.y = NSMaxY(frame) - height - 7.0;
  frame.size = NSMakeSize(width, height);
  [gSpaceControllerPanel setFrame:frame display:YES];
}

void RemoveSpaceController() {
  NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
  if (gSpaceControllerMoveObserver) [center removeObserver:gSpaceControllerMoveObserver];
  if (gSpaceControllerResizeObserver) [center removeObserver:gSpaceControllerResizeObserver];
  gSpaceControllerMoveObserver = nil;
  gSpaceControllerResizeObserver = nil;
  if (gSpaceControllerHostWindow && gSpaceControllerPanel) {
    [gSpaceControllerHostWindow removeChildWindow:gSpaceControllerPanel];
  }
  [gSpaceControllerPanel orderOut:nil];
  [gSpaceControllerPanel release];
  gSpaceControllerPanel = nil;
  [gSpaceControllerHostWindow release];
  gSpaceControllerHostWindow = nil;
}

static void InstallShellControls(NSWindow* host, NSString* socketPath) {
  if (!host || !socketPath.length) {
    RemoveShellControls();
    return;
  }
  if (gShellPanel && gShellHostWindow == host) {
    gShellPanel.buttonView.socketPath = socketPath;
    gShellPanel.ignoresMouseEvents = host.ignoresMouseEvents;
    gShellPanel.alphaValue = host.ignoresMouseEvents ? 0.0 : 1.0;
    PositionShellButton();
    return;
  }
  RemoveShellControls();
  gShellHostWindow = [host retain];
  gShellPanel = [[UfoShellPanel alloc] initWithContentRect:NSMakeRect(0, 0, 34.0, 30.0)
                                                  styleMask:NSWindowStyleMaskBorderless
                                                    backing:NSBackingStoreBuffered
                                                      defer:NO];
  gShellPanel.hostWindow = host;
  gShellPanel.opaque = NO;
  gShellPanel.backgroundColor = NSColor.clearColor;
  gShellPanel.hasShadow = NO;
  gShellPanel.alphaValue = host.ignoresMouseEvents ? 0.0 : 1.0;
  gShellPanel.ignoresMouseEvents = host.ignoresMouseEvents;
  // UFO's Spaces affordance must remain usable above the Agent input-blocking
  // panel; Chromium's toolbar/page stay below both layers.
  gShellPanel.level = host.level + 2;
  gShellPanel.collectionBehavior = NSWindowCollectionBehaviorMoveToActiveSpace |
                                    NSWindowCollectionBehaviorFullScreenAuxiliary;
  UfoShellButtonView* button = [[UfoShellButtonView alloc] initWithFrame:NSMakeRect(0, 0, 34.0, 30.0)];
  button.socketPath = socketPath;
  gShellPanel.buttonView = button;
  gShellPanel.contentView = button;
  [host addChildWindow:gShellPanel ordered:NSWindowAbove];
  PositionShellButton();
  [gShellPanel orderFront:nil];
  NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
  gShellMoveObserver = [center addObserverForName:NSWindowDidMoveNotification object:host queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification* note) {
    (void)note;
    PositionShellButton();
  }];
  gShellResizeObserver = [center addObserverForName:NSWindowDidResizeNotification object:host queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification* note) {
    (void)note;
    PositionShellButton();
  }];
}

static void InstallSpaceController(NSWindow* host,
                                   UfoChromeControlsMetadata* metadata) {
  if (!host || !metadata.socketPath.length || !metadata.spaceName.length) {
    RemoveSpaceController();
    return;
  }
  if (gSpaceControllerPanel && gSpaceControllerHostWindow == host) {
    gSpaceControllerPanel.controllerView.spaceName = metadata.spaceName;
    gSpaceControllerPanel.controllerView.profileName = metadata.profileName;
    gSpaceControllerPanel.controllerView.socketPath = metadata.socketPath;
    gSpaceControllerPanel.ignoresMouseEvents = host.ignoresMouseEvents;
    gSpaceControllerPanel.alphaValue = host.ignoresMouseEvents ? 0.0 : 1.0;
    [gSpaceControllerPanel.controllerView setNeedsDisplay:YES];
    PositionSpaceController();
    return;
  }
  RemoveSpaceController();
  gSpaceControllerHostWindow = [host retain];
  gSpaceControllerPanel = [[UfoSpaceControllerPanel alloc] initWithContentRect:NSMakeRect(0, 0, 240.0, 30.0)
                                                                        styleMask:NSWindowStyleMaskBorderless
                                                                          backing:NSBackingStoreBuffered
                                                                            defer:NO];
  gSpaceControllerPanel.hostWindow = host;
  gSpaceControllerPanel.opaque = NO;
  gSpaceControllerPanel.backgroundColor = NSColor.clearColor;
  gSpaceControllerPanel.hasShadow = NO;
  gSpaceControllerPanel.alphaValue = host.ignoresMouseEvents ? 0.0 : 1.0;
  gSpaceControllerPanel.ignoresMouseEvents = host.ignoresMouseEvents;
  gSpaceControllerPanel.level = host.level + 2;
  gSpaceControllerPanel.collectionBehavior = NSWindowCollectionBehaviorMoveToActiveSpace |
                                              NSWindowCollectionBehaviorFullScreenAuxiliary;
  UfoSpaceControllerView* controller = [[UfoSpaceControllerView alloc] initWithFrame:NSMakeRect(0, 0, 240.0, 30.0)];
  controller.spaceName = metadata.spaceName;
  controller.profileName = metadata.profileName;
  controller.socketPath = metadata.socketPath;
  gSpaceControllerPanel.controllerView = controller;
  gSpaceControllerPanel.contentView = controller;
  [host addChildWindow:gSpaceControllerPanel ordered:NSWindowAbove];
  PositionSpaceController();
  [gSpaceControllerPanel orderFront:nil];
  NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
  gSpaceControllerMoveObserver = [center addObserverForName:NSWindowDidMoveNotification object:host queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification* note) {
    (void)note;
    PositionSpaceController();
  }];
  gSpaceControllerResizeObserver = [center addObserverForName:NSWindowDidResizeNotification object:host queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification* note) {
    (void)note;
    PositionSpaceController();
  }];
}

static void PresentChromeControlsForHost(NSWindow* host) {
  UfoChromeControlsMetadata* metadata = MetadataForHost(host, NO);
  if (!metadata || !metadata.socketPath.length) {
    RemoveShellControls();
    RemoveSpaceController();
    return;
  }
  InstallShellControls(host, metadata.socketPath);
  InstallSpaceController(host, metadata);
}

void UfoCefWindowSetPresented(void* cef_view_handle, bool presented) {
  NSView* view = (NSView*)cef_view_handle;
  if (!view) return;
  [view retain];
  void (^update)(void) = ^{
    NSWindow* host = view.window;
    if (!host) {
      [view release];
      return;
    }
    // Keep the window ordered and backed by Chromium even when not presented
    // to a human. This is deliberately separate from the Agent overlay panel.
    // A short AppKit cross-fade removes the hard flash when Overview and a
    // native Chrome Space exchange presentation, without animating the page
    // or changing the compositor surface used for Agent screenshots.
    host.ignoresMouseEvents = !presented;
    if (presented) {
      [host orderFrontRegardless];
      // Chrome controls are registered when a Space window is created but
      // physically attached only when that window becomes UFO's one presented
      // surface. This prevents a warm/background Space from stealing the
      // controls merely because its BrowserView was created later.
      PresentChromeControlsForHost(host);
    } else {
      [host orderFront:nil];
    }
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context) {
      context.duration = 0.16;
      context.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
      host.animator.alphaValue = presented ? 1.0 : 0.0;
      if (gPanel && gHostWindow == host) {
        gPanel.ignoresMouseEvents = !presented;
        gPanel.animator.alphaValue = presented ? 1.0 : 0.0;
      }
      if (gShellPanel && gShellHostWindow == host) {
        gShellPanel.ignoresMouseEvents = !presented;
        gShellPanel.animator.alphaValue = presented ? 1.0 : 0.0;
        PositionShellButton();
      }
      if (gSpaceControllerPanel && gSpaceControllerHostWindow == host) {
        gSpaceControllerPanel.ignoresMouseEvents = !presented;
        gSpaceControllerPanel.animator.alphaValue = presented ? 1.0 : 0.0;
        PositionSpaceController();
      }
    } completionHandler:nil];
    [view release];
  };
  if (NSThread.isMainThread) update();
  else dispatch_async(dispatch_get_main_queue(), update);
}

bool UfoCefWindowIsPresented(void* cef_view_handle) {
  NSView* view = (NSView*)cef_view_handle;
  if (!view || !view.window) return false;
  NSWindow* host = view.window;
  return host.isVisible && host.alphaValue > 0.5 && !host.ignoresMouseEvents;
}

void UfoCefWindowSetCompositorAwake(void* cef_view_handle, bool awake) {
  NSView* view = (NSView*)cef_view_handle;
  if (!view) return;
  [view retain];
  void (^update)(void) = ^{
    NSWindow* host = view.window;
    if (!host) {
      [view release];
      return;
    }
    if (awake) {
      [CompositorAwakeState() setObject:@YES forKey:host];
      // Keep the background surface transparent/non-interactive. Ordering it
      // without activation is sufficient for Chromium to resume producing a
      // compositor frame for Agent input or a low-frequency Overview capture.
      [host orderFront:nil];
      [view release];
      return;
    }
    [CompositorAwakeState() setObject:@NO forKey:host];
    // Let the presentation cross-fade finish before ordering the window out.
    // Re-check state at the deadline so a rapid reopen/Agent claim cannot be
    // hidden by an older delayed sleep request.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,
                                 static_cast<int64_t>(0.22 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
      const bool still_sleeping =
          ![[CompositorAwakeState() objectForKey:host] boolValue];
      if (still_sleeping && host.ignoresMouseEvents && host.alphaValue < 0.1) {
        [host orderOut:nil];
      }
      [view release];
    });
  };
  if (NSThread.isMainThread) update();
  else dispatch_async(dispatch_get_main_queue(), update);
}

bool UfoCefWindowIsCompositorAwake(void* cef_view_handle) {
  NSView* view = (NSView*)cef_view_handle;
  return view && view.window && view.window.isVisible;
}

void UfoCefShellControlsSet(void* cef_view_handle, const char* presentation_socket) {
  NSView* retainedCefView = [(NSView*)cef_view_handle retain];
  const std::string socketValue = presentation_socket ?: "";
  dispatch_async(dispatch_get_main_queue(), ^{
    NSView* cefView = retainedCefView;
    NSWindow* host = cefView.window;
    if (!host) {
      [cefView release];
      return;
    }
    UfoChromeControlsMetadata* metadata = MetadataForHost(host, YES);
    metadata.socketPath = [NSString stringWithUTF8String:socketValue.c_str()];
    if (!metadata.socketPath.length) {
      [ChromeControlsMetadata() removeObjectForKey:host];
      if (gShellHostWindow == host) RemoveShellControls();
      if (gSpaceControllerHostWindow == host) RemoveSpaceController();
    } else if (!host.ignoresMouseEvents) {
      PresentChromeControlsForHost(host);
    }
    [cefView release];
  });
}

void UfoCefSpaceControllerSet(void* cef_view_handle,
                              const char* space_name,
                              const char* profile_name,
                              const char* presentation_socket) {
  NSView* retainedCefView = [(NSView*)cef_view_handle retain];
  const std::string spaceValue = space_name ?: "Space";
  const std::string profileValue = profile_name ?: "Default";
  const std::string socketValue = presentation_socket ?: "";
  dispatch_async(dispatch_get_main_queue(), ^{
    NSView* cefView = retainedCefView;
    NSWindow* host = cefView.window;
    if (!host) {
      [cefView release];
      return;
    }
    UfoChromeControlsMetadata* metadata = MetadataForHost(host, YES);
    metadata.spaceName = [NSString stringWithUTF8String:spaceValue.c_str()];
    metadata.profileName = [NSString stringWithUTF8String:profileValue.c_str()];
    metadata.socketPath = [NSString stringWithUTF8String:socketValue.c_str()];
    if (!metadata.socketPath.length) {
      [ChromeControlsMetadata() removeObjectForKey:host];
      if (gShellHostWindow == host) RemoveShellControls();
      if (gSpaceControllerHostWindow == host) RemoveSpaceController();
    } else if (!host.ignoresMouseEvents) {
      PresentChromeControlsForHost(host);
    }
    [cefView release];
  });
}

void UfoCefChromeControlsClear(void* cef_view_handle) {
  NSView* cefView = (NSView*)cef_view_handle;
  if (!cefView) return;
  [cefView retain];
  void (^update)(void) = ^{
    NSWindow* host = cefView.window;
    if (host) {
      [ChromeControlsMetadata() removeObjectForKey:host];
      if (gShellHostWindow == host) RemoveShellControls();
      if (gSpaceControllerHostWindow == host) RemoveSpaceController();
    }
    [cefView release];
  };
  if (NSThread.isMainThread) update();
  else dispatch_async(dispatch_get_main_queue(), update);
}

bool UfoCefChromeControlsArePresentedForWindow(void* cef_view_handle) {
  NSView* view = (NSView*)cef_view_handle;
  if (!view || !view.window) return false;
  NSWindow* host = view.window;
  return gShellPanel && gShellHostWindow == host && gShellPanel.parentWindow == host &&
      gShellPanel.alphaValue > 0.5 && !gShellPanel.ignoresMouseEvents &&
      gSpaceControllerPanel && gSpaceControllerHostWindow == host &&
      gSpaceControllerPanel.parentWindow == host &&
      gSpaceControllerPanel.alphaValue > 0.5 &&
      !gSpaceControllerPanel.ignoresMouseEvents;
}

bool UfoCefChromeControlsOwnWindow(void* ns_window) {
  NSWindow* window = (NSWindow*)ns_window;
  return window && (window == gShellPanel || window == gSpaceControllerPanel);
}

void UfoCefRequestSpaceClose(int space_id, const char* presentation_socket) {
  if (space_id <= 0 || !presentation_socket || !*presentation_socket) return;
  const std::string socketPath = presentation_socket;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    if (socketPath.size() >= sizeof(sockaddr_un{}.sun_path)) return;
    const int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return;
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::strncpy(address.sun_path, socketPath.c_str(),
                 sizeof(address.sun_path) - 1);
    if (::connect(fd, reinterpret_cast<sockaddr*>(&address),
                  sizeof(address)) == 0) {
      const std::string command =
          std::string("{\"command\":\"close-space\",\"spaceId\":") +
          std::to_string(space_id) + "}\n";
      (void)::write(fd, command.data(), command.size());
    }
    ::close(fd);
  });
}

void UfoAgentOverlaySet(void* cef_view_handle,
                        bool active,
                        const char* label,
                        int space_id,
                        const char* presentation_socket) {
  NSView* retainedCefView = [(NSView*)cef_view_handle retain];
  const std::string socketValue = presentation_socket ?: "";
  dispatch_async(dispatch_get_main_queue(), ^{
    NSView* cefView = retainedCefView;
    NSWindow* host = cefView.window;
    if (!active || !host) {
      RemoveOverlay();
      [cefView release];
      return;
    }
    if (gPanel && gHostWindow == host) {
      gPanel.overlayView.label = [NSString stringWithUTF8String:label ?: "Agent controlling"];
      gPanel.overlayView.spaceId = space_id;
      gPanel.overlayView.socketPath = [NSString stringWithUTF8String:socketValue.c_str()];
      PositionOverlay();
      [gPanel orderFront:nil];
      [cefView release];
      return;
    }
    RemoveOverlay();
    gHostWindow = [host retain];
    NSRect frame = [host.contentView convertRect:host.contentView.bounds toView:nil];
    frame = [host convertRectToScreen:frame];
    gPanel = [[UfoOverlayPanel alloc] initWithContentRect:frame
                                                styleMask:NSWindowStyleMaskBorderless
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
    gPanel.hostWindow = host;
    gPanel.opaque = NO;
    gPanel.backgroundColor = NSColor.clearColor;
    gPanel.alphaValue = host.ignoresMouseEvents ? 0.0 : 1.0;
    gPanel.hasShadow = NO;
    gPanel.ignoresMouseEvents = host.ignoresMouseEvents;
    gPanel.hidesOnDeactivate = NO;
    gPanel.level = host.level + 1;
    gPanel.collectionBehavior = NSWindowCollectionBehaviorMoveToActiveSpace |
                                NSWindowCollectionBehaviorFullScreenAuxiliary;
    UfoOverlayView* view = [[UfoOverlayView alloc] initWithFrame:NSMakeRect(0, 0, frame.size.width, frame.size.height)];
    view.label = [NSString stringWithUTF8String:label ?: "Agent controlling"];
    view.spaceId = space_id;
    view.socketPath = [NSString stringWithUTF8String:socketValue.c_str()];
    view.phase = 0.0;
    gPanel.overlayView = view;
    gPanel.contentView = view;
    [host addChildWindow:gPanel ordered:NSWindowAbove];
    [gPanel orderFront:nil];
    // Redraw only the small capsule at a restrained cadence. Repositioning or
    // repainting the full-window transparent panel every frame needlessly
    // wakes the compositor and was visible in UFO's idle GPU usage.
    gPanel.pulseTimer = [NSTimer scheduledTimerWithTimeInterval:1.0 / 12.0
                                                           repeats:YES
                                                             block:^(NSTimer* timer) {
      (void)timer;
      if (!gPanel) return;
      gPanel.overlayView.phase += 0.20;
      [gPanel.overlayView setNeedsDisplayInRect:UfoOverlayCapsuleRect(gPanel.overlayView.bounds)];
    }];
    NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
    gMoveObserver = [center addObserverForName:NSWindowDidMoveNotification object:host queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification* note) {
      (void)note;
      PositionOverlay();
    }];
    gResizeObserver = [center addObserverForName:NSWindowDidResizeNotification object:host queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification* note) {
      (void)note;
      PositionOverlay();
    }];
    [cefView release];
  });
}

void UfoAgentOverlayClear(void* cef_view_handle) {
  (void)cef_view_handle;
  dispatch_async(dispatch_get_main_queue(), ^{ RemoveOverlay(); });
}

bool UfoAgentOverlayIsActiveForWindow(void* cef_view_handle) {
  NSView* view = (NSView*)cef_view_handle;
  return view && view.window && gPanel && gHostWindow == view.window &&
      gPanel.isVisible && gPanel.alphaValue > 0.5 && !gPanel.ignoresMouseEvents;
}

bool UfoAgentOverlayHasActionsForWindow(void* cef_view_handle) {
  if (!UfoAgentOverlayIsActiveForWindow(cef_view_handle)) return false;
  return gPanel.overlayView.spaceId > 0 && gPanel.overlayView.socketPath.length > 0;
}

bool UfoAgentOverlayOwnsWindow(void* ns_window) {
  return ns_window && gPanel && gPanel == (NSWindow*)ns_window;
}
