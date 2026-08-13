#import <Cocoa/Cocoa.h>

#include <cmath>
#include <cstring>

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

static UfoOverlayPanel* gPanel;
static NSWindow* gHostWindow;
static id gMoveObserver;
static id gResizeObserver;

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
