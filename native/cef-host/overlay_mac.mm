#import <Cocoa/Cocoa.h>

#include <cmath>
#include <cstring>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "native/cef-host/overlay_mac.h"

@interface UfoOverlayView : NSView
@property(nonatomic, copy) NSString* label;
@property(nonatomic) CGFloat phase;
@end

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
  CGFloat capsuleWidth = MIN(260.0, MAX(190.0, bounds.size.width * 0.26));
  NSRect capsule = NSMakeRect((NSWidth(bounds) - capsuleWidth) / 2.0,
                              NSHeight(bounds) - 62.0, capsuleWidth, 34.0);
  CGFloat pulse = 0.5 + 0.5 * std::sin(self.phase);
  NSColor* fill = [NSColor colorWithCalibratedWhite:0.10 alpha:0.88 - pulse * 0.04];
  NSColor* stroke = [NSColor colorWithCalibratedWhite:1.0 alpha:0.13 + pulse * 0.06];
  NSBezierPath* path = [NSBezierPath bezierPathWithRoundedRect:capsule xRadius:17.0 yRadius:17.0];
  [fill setFill];
  [path fill];
  [stroke setStroke];
  [path setLineWidth:1.0];
  [path stroke];

  NSRect dot = NSMakeRect(NSMinX(capsule) + 13.0,
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
  [text drawAtPoint:NSMakePoint(NSMidX(capsule) - textSize.width / 2.0 + 7.0,
                                NSMidY(capsule) - textSize.height / 2.0)
      withAttributes:attrs];
}

// Swallow all human input while the agent owns the Space. CEF's DevTools/CDP
// transport does not go through this AppKit event path and remains unaffected.
- (void)mouseDown:(NSEvent*)event {}
- (void)mouseUp:(NSEvent*)event {}
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

static UfoOverlayPanel* gPanel;
static NSWindow* gHostWindow;
static id gMoveObserver;
static id gResizeObserver;
static UfoShellPanel* gShellPanel;
static NSWindow* gShellHostWindow;
static id gShellMoveObserver;
static id gShellResizeObserver;

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
    host.alphaValue = presented ? 1.0 : 0.0;
    host.ignoresMouseEvents = !presented;
    if (gPanel && gHostWindow == host) {
      gPanel.alphaValue = presented ? 1.0 : 0.0;
      gPanel.ignoresMouseEvents = !presented;
    }
    if (gShellPanel && gShellHostWindow == host) {
      gShellPanel.alphaValue = presented ? 1.0 : 0.0;
      gShellPanel.ignoresMouseEvents = !presented;
      PositionShellButton();
    }
    if (presented) {
      [host orderFrontRegardless];
    } else {
      [host orderFront:nil];
    }
    [view release];
  };
  if (NSThread.isMainThread) update();
  else dispatch_async(dispatch_get_main_queue(), update);
}

void UfoCefShellControlsSet(void* cef_view_handle, const char* presentation_socket) {
  NSView* retainedCefView = [(NSView*)cef_view_handle retain];
  const char* socket = presentation_socket ?: "";
  NSString* socketPath = [NSString stringWithUTF8String:socket];
  dispatch_async(dispatch_get_main_queue(), ^{
    NSView* cefView = retainedCefView;
    NSWindow* host = cefView.window;
    if (!host || !socketPath.length) {
      RemoveShellControls();
      [cefView release];
      return;
    }
    if (gShellPanel && gShellHostWindow == host) {
      gShellPanel.buttonView.socketPath = socketPath;
      PositionShellButton();
      [cefView release];
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
    gShellPanel.alphaValue = host.alphaValue > 0.01 ? 1.0 : 0.0;
    gShellPanel.ignoresMouseEvents = host.ignoresMouseEvents;
    gShellPanel.level = host.level + 1;
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
    [cefView release];
  });
}

void UfoCefShellControlsClear() {
  dispatch_async(dispatch_get_main_queue(), ^{ RemoveShellControls(); });
}

void UfoAgentOverlaySet(void* cef_view_handle, bool active, const char* label) {
  NSView* retainedCefView = [(NSView*)cef_view_handle retain];
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
    gPanel.alphaValue = host.alphaValue > 0.01 ? 1.0 : 0.0;
    gPanel.hasShadow = NO;
    gPanel.ignoresMouseEvents = NO;
    gPanel.hidesOnDeactivate = NO;
    gPanel.level = host.level + 1;
    gPanel.collectionBehavior = NSWindowCollectionBehaviorMoveToActiveSpace |
                                NSWindowCollectionBehaviorFullScreenAuxiliary;
    UfoOverlayView* view = [[UfoOverlayView alloc] initWithFrame:NSMakeRect(0, 0, frame.size.width, frame.size.height)];
    view.label = [NSString stringWithUTF8String:label ?: "Agent controlling"];
    view.phase = 0.0;
    gPanel.overlayView = view;
    gPanel.contentView = view;
    [host addChildWindow:gPanel ordered:NSWindowAbove];
    [gPanel orderFront:nil];
    gPanel.pulseTimer = [NSTimer scheduledTimerWithTimeInterval:1.0 / 30.0
                                                           repeats:YES
                                                             block:^(NSTimer* timer) {
      (void)timer;
      if (!gPanel) return;
      gPanel.overlayView.phase += 0.11;
      [gPanel.overlayView setNeedsDisplay:YES];
      PositionOverlay();
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
