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
@property(nonatomic, copy) NSString* detail;
@property(nonatomic, copy) NSString* socketPath;
@property(nonatomic) NSInteger spaceId;
@property(nonatomic, copy) NSString* pressedAction;
@property(nonatomic) CGFloat phase;
@property(nonatomic) CGFloat pointerX;
@property(nonatomic) CGFloat pointerY;
@property(nonatomic) CGFloat pointerTargetX;
@property(nonatomic) CGFloat pointerTargetY;
@property(nonatomic, copy) NSString* pointerLabel;
@property(nonatomic) NSTimeInterval pointerVisibleUntil;
@end

static NSRect UfoOverlayCapsuleRect(NSRect bounds) {
  const CGFloat width = MIN(486.0, MAX(360.0, bounds.size.width - 36.0));
  return NSMakeRect((NSWidth(bounds) - width) / 2.0,
                    24.0, width, 64.0);
}

static NSRect UfoOverlayTerminateRect(NSRect capsule) {
  return NSMakeRect(NSMaxX(capsule) - 94.0, NSMinY(capsule) + 13.0, 84.0, 38.0);
}

static NSRect UfoOverlayTakeOverRect(NSRect capsule) {
  const NSRect terminate = UfoOverlayTerminateRect(capsule);
  return NSMakeRect(NSMinX(terminate) - 76.0, NSMinY(terminate), 66.0, 38.0);
}

static NSRect UfoOverlaySweepRect(NSRect bounds, CGFloat phase) {
  const CGFloat width = MIN(156.0, MAX(96.0, NSWidth(bounds) * 0.10));
  const CGFloat progress = std::fmod(MAX(0.0, phase), 12.0) / 12.0;
  const CGFloat x = -width - 180.0 + progress * (NSWidth(bounds) + width + 360.0);
  return NSMakeRect(x, -NSHeight(bounds) * 0.05, width, NSHeight(bounds) * 1.10);
}

static NSRect UfoOverlayPointerRect(UfoOverlayView* view,
                                    CGFloat x,
                                    CGFloat y) {
  NSDictionary* attrs = @{
    NSFontAttributeName: [NSFont systemFontOfSize:11.0 weight:NSFontWeightSemibold],
  };
  NSString* label = view.pointerLabel.length ? view.pointerLabel : @"正在浏览网页";
  const CGFloat labelWidth = MIN(210.0, [label sizeWithAttributes:attrs].width + 22.0);
  const CGFloat totalWidth = 18.0 + 6.0 + labelWidth;
  const CGFloat clampedX = MIN(MAX(8.0, x), MAX(8.0, NSWidth(view.bounds) - totalWidth - 8.0));
  const CGFloat topY = MIN(MAX(8.0, y), MAX(8.0, NSHeight(view.bounds) - 34.0));
  return NSMakeRect(clampedX - 4.0,
                    NSHeight(view.bounds) - topY - 34.0,
                    totalWidth + 8.0, 38.0);
}

@implementation UfoOverlayView

- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)canBecomeKeyView { return YES; }
- (BOOL)isOpaque { return NO; }

- (void)drawRect:(NSRect)dirtyRect {
  [super drawRect:dirtyRect];
  NSRect bounds = self.bounds;

  // Port of the original UFO/Ego-compatible renderer overlay. It is drawn in
  // an AppKit child panel, so the human sees and is blocked by the veil while
  // CEF screenshots and DevTools input remain completely unobstructed.
  [[NSColor colorWithCalibratedRed:0.035 green:0.047 blue:0.071 alpha:0.34] setFill];
  NSRectFillUsingOperation(dirtyRect, NSCompositingOperationCopy);

  // Sparse neutral dot matrix. Only dots inside the dirty clip are emitted,
  // keeping the low-frequency motion inexpensive on large Retina windows.
  [[NSColor colorWithCalibratedRed:0.93 green:0.95 blue:1.0 alpha:0.26] setFill];
  const CGFloat dotStep = 8.0;
  const CGFloat startX = std::floor(NSMinX(dirtyRect) / dotStep) * dotStep;
  const CGFloat startY = std::floor(NSMinY(dirtyRect) / dotStep) * dotStep;
  for (CGFloat x = startX; x <= NSMaxX(dirtyRect); x += dotStep) {
    for (CGFloat y = startY; y <= NSMaxY(dirtyRect); y += dotStep) {
      [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(x, y, 1.25, 1.25)] fill];
    }
  }

  // Soft blue edge light without a full-screen blur or vibrancy layer.
  [[NSColor colorWithCalibratedRed:0.34 green:0.49 blue:1.0 alpha:0.13] setStroke];
  NSBezierPath* leftGlow = [NSBezierPath bezierPathWithOvalInRect:
      NSMakeRect(-NSWidth(bounds) * 0.34, NSHeight(bounds) * 0.18,
                 NSWidth(bounds) * 0.48, NSHeight(bounds) * 0.66)];
  [leftGlow setLineWidth:72.0];
  [leftGlow stroke];
  NSBezierPath* rightGlow = [NSBezierPath bezierPathWithOvalInRect:
      NSMakeRect(NSWidth(bounds) * 0.86, NSHeight(bounds) * 0.18,
                 NSWidth(bounds) * 0.48, NSHeight(bounds) * 0.66)];
  [rightGlow setLineWidth:72.0];
  [rightGlow stroke];
  [[NSColor colorWithCalibratedRed:0.42 green:0.56 blue:1.0 alpha:0.15] setStroke];
  NSBezierPath* bottomGlow = [NSBezierPath bezierPathWithOvalInRect:
      NSMakeRect(NSWidth(bounds) * 0.13, -NSHeight(bounds) * 0.34,
                 NSWidth(bounds) * 0.74, NSHeight(bounds) * 0.52)];
  [bottomGlow setLineWidth:88.0];
  [bottomGlow stroke];

  NSBezierPath* edge = [NSBezierPath bezierPathWithRect:NSInsetRect(bounds, 0.5, 0.5)];
  [[NSColor colorWithCalibratedRed:0.83 green:0.88 blue:1.0 alpha:0.28] setStroke];
  [edge setLineWidth:1.0];
  [edge stroke];

  const NSRect sweep = UfoOverlaySweepRect(bounds, self.phase);
  NSGradient* sweepGradient = [[[NSGradient alloc]
      initWithColors:@[
        [NSColor colorWithCalibratedWhite:1.0 alpha:0.0],
        [NSColor colorWithCalibratedRed:0.90 green:0.93 blue:1.0 alpha:0.15],
        [NSColor colorWithCalibratedWhite:1.0 alpha:0.0],
      ]] autorelease];
  NSBezierPath* sweepPath = [NSBezierPath bezierPathWithRoundedRect:sweep xRadius:20.0 yRadius:20.0];
  [sweepGradient drawInBezierPath:sweepPath angle:0.0];

  NSRect capsule = UfoOverlayCapsuleRect(bounds);
  CGFloat pulse = 0.5 + 0.5 * std::sin(self.phase);
  NSColor* fill = [NSColor colorWithCalibratedRed:0.059 green:0.071 blue:0.098 alpha:0.965];
  NSColor* stroke = [NSColor colorWithCalibratedWhite:1.0 alpha:0.09 + pulse * 0.015];
  NSBezierPath* path = [NSBezierPath bezierPathWithRoundedRect:capsule xRadius:24.0 yRadius:24.0];
  NSShadow* barShadow = [[[NSShadow alloc] init] autorelease];
  barShadow.shadowColor = [NSColor colorWithCalibratedWhite:0.0 alpha:0.42];
  barShadow.shadowBlurRadius = 28.0;
  barShadow.shadowOffset = NSMakeSize(0.0, -12.0);
  [NSGraphicsContext saveGraphicsState];
  [barShadow set];
  [fill setFill];
  [path fill];
  [NSGraphicsContext restoreGraphicsState];
  [stroke setStroke];
  [path setLineWidth:1.0];
  [path stroke];

  // Pause mark and the gently rotating Agent orbit from the old overlay.
  [[NSColor colorWithCalibratedWhite:0.90 alpha:0.56] setFill];
  [[NSBezierPath bezierPathWithRoundedRect:
      NSMakeRect(NSMinX(capsule) + 14.0, NSMidY(capsule) - 5.0, 2.0, 10.0)
      xRadius:1.0 yRadius:1.0] fill];
  [[NSBezierPath bezierPathWithRoundedRect:
      NSMakeRect(NSMinX(capsule) + 19.0, NSMidY(capsule) - 5.0, 2.0, 10.0)
      xRadius:1.0 yRadius:1.0] fill];
  const NSPoint agentCenter = NSMakePoint(NSMinX(capsule) + 46.0, NSMidY(capsule));
  [[NSColor colorWithCalibratedRed:0.50 green:0.94 blue:0.82 alpha:0.88] setFill];
  for (NSInteger index = 0; index < 8; index += 1) {
    const CGFloat angle = self.phase * 0.55 + index * (3.141592653589793 * 2.0 / 8.0);
    const CGFloat alpha = 0.28 + 0.68 * ((CGFloat)index / 7.0);
    [[NSColor colorWithCalibratedRed:0.78 green:1.0 blue:0.94 alpha:alpha] setFill];
    [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(
        agentCenter.x + std::cos(angle) * 10.0 - 1.4,
        agentCenter.y + std::sin(angle) * 10.0 - 1.4, 2.8, 2.8)] fill];
  }
  [[NSColor colorWithCalibratedRed:0.79 green:1.0 blue:0.94 alpha:0.98] setFill];
  [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(
      agentCenter.x - 3.0, agentCenter.y - 3.0, 6.0, 6.0)] fill];

  NSDictionary* attrs = @{
    NSFontAttributeName: [NSFont systemFontOfSize:14.0 weight:NSFontWeightSemibold],
    NSForegroundColorAttributeName: [NSColor colorWithCalibratedWhite:1.0 alpha:0.98],
  };
  NSDictionary* detailAttrs = @{
    NSFontAttributeName: [NSFont systemFontOfSize:11.0 weight:NSFontWeightMedium],
    NSForegroundColorAttributeName: [NSColor colorWithCalibratedWhite:0.86 alpha:0.78],
  };
  NSString* text = self.label.length ? self.label : @"Browser Agent";
  NSString* detail = self.detail.length ? self.detail : @"Agent 正在控制";
  const CGFloat textX = NSMinX(capsule) + 68.0;
  const CGFloat maxTextWidth = MAX(40.0, NSMinX(UfoOverlayTakeOverRect(capsule)) - textX - 10.0);
  while (text.length > 4 && [text sizeWithAttributes:attrs].width > maxTextWidth) {
    text = [[text substringToIndex:text.length - 2] stringByAppendingString:@"…"];
  }
  while (detail.length > 4 && [detail sizeWithAttributes:detailAttrs].width > maxTextWidth) {
    detail = [[detail substringToIndex:detail.length - 2] stringByAppendingString:@"…"];
  }
  [text drawAtPoint:NSMakePoint(textX, NSMidY(capsule) + 3.0) withAttributes:attrs];
  [detail drawAtPoint:NSMakePoint(textX, NSMidY(capsule) - 16.0) withAttributes:detailAttrs];

  const NSRect takeOver = UfoOverlayTakeOverRect(capsule);
  const NSRect terminate = UfoOverlayTerminateRect(capsule);
  for (NSString* action in @[@"take-over-space", @"terminate-space"]) {
    const BOOL isTakeOver = [action isEqualToString:@"take-over-space"];
    const NSRect button = isTakeOver ? takeOver : terminate;
    const BOOL pressed = [self.pressedAction isEqualToString:action];
    NSColor* buttonFill = isTakeOver
        ? [NSColor colorWithCalibratedWhite:1.0 alpha:pressed ? 0.13 : 0.045]
        : [NSColor colorWithCalibratedRed:1.0 green:0.37 blue:0.28 alpha:pressed ? 0.16 : 0.035];
    NSBezierPath* buttonPath = [NSBezierPath bezierPathWithRoundedRect:button xRadius:13.0 yRadius:13.0];
    [buttonFill setFill];
    [buttonPath fill];
    [[NSColor colorWithCalibratedWhite:1.0 alpha:0.055] setStroke];
    [buttonPath setLineWidth:1.0];
    [buttonPath stroke];
    NSString* title = isTakeOver ? @"接管" : @"终止任务";
    NSDictionary* buttonAttrs = @{
      NSFontAttributeName: [NSFont systemFontOfSize:12.0 weight:NSFontWeightSemibold],
      NSForegroundColorAttributeName: isTakeOver
          ? [NSColor colorWithCalibratedWhite:0.98 alpha:0.96]
          : [NSColor colorWithCalibratedRed:1.0 green:0.40 blue:0.31 alpha:0.98],
    };
    NSSize size = [title sizeWithAttributes:buttonAttrs];
    [title drawAtPoint:NSMakePoint(NSMidX(button) - size.width / 2.0,
                                   NSMidY(button) - size.height / 2.0)
         withAttributes:buttonAttrs];
  }

  if (self.pointerVisibleUntil > [NSDate timeIntervalSinceReferenceDate]) {
    NSRect pointerRect = UfoOverlayPointerRect(self, self.pointerX, self.pointerY);
    const CGFloat cursorX = NSMinX(pointerRect) + 4.0;
    const CGFloat cursorY = NSMinY(pointerRect) + 12.0;
    NSBezierPath* cursor = [NSBezierPath bezierPath];
    [cursor moveToPoint:NSMakePoint(cursorX, cursorY + 21.0)];
    [cursor lineToPoint:NSMakePoint(cursorX, cursorY + 4.8)];
    [cursor lineToPoint:NSMakePoint(cursorX + 4.3, cursorY + 8.8)];
    [cursor lineToPoint:NSMakePoint(cursorX + 7.5, cursorY + 2.1)];
    [cursor lineToPoint:NSMakePoint(cursorX + 10.5, cursorY + 3.55)];
    [cursor lineToPoint:NSMakePoint(cursorX + 7.4, cursorY + 10.1)];
    [cursor lineToPoint:NSMakePoint(cursorX + 13.0, cursorY + 10.35)];
    [cursor closePath];
    [[NSColor colorWithCalibratedWhite:1.0 alpha:0.98] setFill];
    [cursor fill];
    [[NSColor colorWithCalibratedWhite:0.10 alpha:0.92] setStroke];
    [cursor setLineWidth:1.2];
    [cursor stroke];

    NSRect labelRect = NSMakeRect(cursorX + 24.0, NSMinY(pointerRect) + 3.0,
                                  NSWidth(pointerRect) - 32.0, 32.0);
    NSBezierPath* labelPath = [NSBezierPath bezierPathWithRoundedRect:labelRect xRadius:13.0 yRadius:13.0];
    [[NSColor colorWithCalibratedWhite:0.98 alpha:0.98] setFill];
    [labelPath fill];
    NSDictionary* pointerAttrs = @{
      NSFontAttributeName: [NSFont systemFontOfSize:11.0 weight:NSFontWeightSemibold],
      NSForegroundColorAttributeName: [NSColor colorWithCalibratedRed:0.15 green:0.17 blue:0.21 alpha:1.0],
    };
    NSString* pointerText = self.pointerLabel.length ? self.pointerLabel : @"正在浏览网页";
    const CGFloat pointerMaxWidth = MAX(20.0, NSWidth(labelRect) - 22.0);
    while (pointerText.length > 4 &&
           [pointerText sizeWithAttributes:pointerAttrs].width > pointerMaxWidth) {
      pointerText = [[pointerText substringToIndex:pointerText.length - 2]
          stringByAppendingString:@"…"];
    }
    NSSize pointerTextSize = [pointerText sizeWithAttributes:pointerAttrs];
    [pointerText drawAtPoint:NSMakePoint(NSMinX(labelRect) + 11.0,
                                         NSMidY(labelRect) - pointerTextSize.height / 2.0)
              withAttributes:pointerAttrs];
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

@interface UfoNativeSpaceWindowBinding : NSObject
@property(nonatomic, assign) NSButton* closeButton;
@property(nonatomic, assign) id originalTarget;
@property(nonatomic, assign) SEL originalAction;
@property(nonatomic) BOOL originalEnabled;
@property(nonatomic) NSInteger spaceId;
@property(nonatomic, copy) NSString* socketPath;
@property(nonatomic) BOOL agentActive;
- (void)requestClose:(id)sender;
@end

@implementation UfoNativeSpaceWindowBinding

- (void)requestClose:(id)sender {
  (void)sender;
  if (self.agentActive || self.spaceId <= 0 || !self.socketPath.length) return;
  const std::string socketPath = self.socketPath.UTF8String ?: "";
  const NSInteger spaceId = self.spaceId;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    if (socketPath.empty() ||
        socketPath.size() >= sizeof(sockaddr_un{}.sun_path)) return;
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
          std::to_string(spaceId) + "}\n";
      (void)::write(fd, command.data(), command.size());
    }
    ::close(fd);
  });
}

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
static NSMapTable<NSWindow*, UfoNativeSpaceWindowBinding*>*
    gNativeSpaceWindowBindings;
static NSWindow* gProductControllerWindow;
static NSWindow* gMountedSpaceWindow;
static id gProductControllerMoveObserver;
static id gProductControllerResizeObserver;

// CefWindowHandle is an NSView* for Views-hosted browsers and an NSWindow*
// for Chromium-owned native Chrome windows. Resolve both without forcing the
// presentation/overlay layer to care which CEF hosting model created it.
static NSWindow* HostWindowForCefHandle(void* cef_handle) {
  id object = (id)cef_handle;
  if (!object) return nil;
  if ([object isKindOfClass:NSWindow.class]) return (NSWindow*)object;
  if ([object isKindOfClass:NSView.class]) return ((NSView*)object).window;
  return nil;
}

static void SyncMountedSpaceFrame() {
  if (!gProductControllerWindow || !gMountedSpaceWindow) return;
  [gMountedSpaceWindow setFrame:gProductControllerWindow.frame display:YES];
}

static void UnmountSpaceWindow(NSWindow* host) {
  if (!host || host != gMountedSpaceWindow) return;
  if (host.parentWindow == gProductControllerWindow) {
    [gProductControllerWindow removeChildWindow:host];
  }
  [gMountedSpaceWindow release];
  gMountedSpaceWindow = nil;
}

static void MountSpaceWindow(NSWindow* host) {
  if (!host || !gProductControllerWindow || host == gProductControllerWindow) {
    return;
  }
  if (gMountedSpaceWindow != host) {
    UnmountSpaceWindow(gMountedSpaceWindow);
    gMountedSpaceWindow = [host retain];
  }
  NSWindow* old_parent = host.parentWindow;
  if (old_parent && old_parent != gProductControllerWindow) {
    [old_parent removeChildWindow:host];
  }
  [host setFrame:gProductControllerWindow.frame display:NO];
  if (host.parentWindow != gProductControllerWindow) {
    [gProductControllerWindow addChildWindow:host ordered:NSWindowAbove];
  }
  [gProductControllerWindow orderFrontRegardless];
}

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

static NSMapTable<NSWindow*, UfoNativeSpaceWindowBinding*>*
NativeSpaceWindowBindings() {
  if (!gNativeSpaceWindowBindings) {
    gNativeSpaceWindowBindings = [[NSMapTable alloc]
        initWithKeyOptions:NSPointerFunctionsWeakMemory |
                           NSPointerFunctionsObjectPersonality
              valueOptions:NSPointerFunctionsStrongMemory
                  capacity:0];
  }
  return gNativeSpaceWindowBindings;
}

static void UpdateNativeSpaceCloseButton(
    UfoNativeSpaceWindowBinding* binding) {
  if (!binding.closeButton) return;
  binding.closeButton.enabled = !binding.agentActive;
  binding.closeButton.toolTip = binding.agentActive
      ? @"Agent 正在控制此 Space"
      : @"关闭 Space";
}

static void RemoveNativeSpaceWindowBinding(NSWindow* host) {
  if (!host) return;
  UfoNativeSpaceWindowBinding* binding =
      [NativeSpaceWindowBindings() objectForKey:host];
  if (!binding) return;
  if (binding.closeButton) {
    binding.closeButton.target = binding.originalTarget;
    binding.closeButton.action = binding.originalAction;
    binding.closeButton.enabled = binding.originalEnabled;
    binding.closeButton.toolTip = nil;
  }
  [NativeSpaceWindowBindings() removeObjectForKey:host];
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
  id nativeHandle = [(id)cef_view_handle retain];
  if (!nativeHandle) return;
  void (^update)(void) = ^{
    NSWindow* host = HostWindowForCefHandle(nativeHandle);
    if (!host) {
      [nativeHandle release];
      return;
    }
    const bool is_product_controller = host == gProductControllerWindow;
    if (is_product_controller && !presented) {
      // Keep the one UFO controller window in place behind the mounted Chrome
      // surface. It is non-interactive while a Space owns presentation, but
      // never disappears or forces AppKit to jump focus to a second location.
      host.ignoresMouseEvents = YES;
      host.alphaValue = 1.0;
      [host orderFrontRegardless];
      [nativeHandle release];
      return;
    }
    if (!is_product_controller && presented) MountSpaceWindow(host);
    if (is_product_controller && presented && gMountedSpaceWindow) {
      NSWindow* mounted = gMountedSpaceWindow;
      mounted.ignoresMouseEvents = YES;
      mounted.alphaValue = 0.0;
      [mounted orderOut:nil];
      UnmountSpaceWindow(mounted);
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
    } completionHandler:^{
      if (!presented && host != gProductControllerWindow &&
          host == gMountedSpaceWindow && host.ignoresMouseEvents) {
        // Detach the visual surface from the controller, but leave ordering
        // policy to UfoCefWindowSetCompositorAwake. Agent-owned background
        // Spaces must remain compositor-awake at alpha 0 for screenshots and
        // CDP input; ordinary sleeping Spaces are ordered out by that separate
        // low-power path after the transition finishes.
        const bool keep_compositor_awake =
            [[CompositorAwakeState() objectForKey:host] boolValue];
        UnmountSpaceWindow(host);
        if (keep_compositor_awake) [host orderFront:nil];
      }
    }];
    [nativeHandle release];
  };
  if (NSThread.isMainThread) update();
  else dispatch_async(dispatch_get_main_queue(), update);
}

bool UfoCefWindowIsPresented(void* cef_view_handle) {
  NSWindow* host = HostWindowForCefHandle(cef_view_handle);
  if (!host) return false;
  return host.isVisible && host.alphaValue > 0.5 && !host.ignoresMouseEvents;
}

void UfoCefWindowFocus(void* cef_view_handle) {
  id nativeHandle = [(id)cef_view_handle retain];
  if (!nativeHandle) return;
  void (^focus)(void) = ^{
    NSWindow* host = HostWindowForCefHandle(nativeHandle);
    if (host) {
      [NSApp activateIgnoringOtherApps:YES];
      [host makeKeyAndOrderFront:nil];
    }
    [nativeHandle release];
  };
  if (NSThread.isMainThread) focus();
  else dispatch_async(dispatch_get_main_queue(), focus);
}

void UfoCefWindowSetCompositorAwake(void* cef_view_handle, bool awake) {
  id nativeHandle = [(id)cef_view_handle retain];
  if (!nativeHandle) return;
  void (^update)(void) = ^{
    NSWindow* host = HostWindowForCefHandle(nativeHandle);
    if (!host) {
      [nativeHandle release];
      return;
    }
    if (awake) {
      [CompositorAwakeState() setObject:@YES forKey:host];
      // Keep the background surface transparent/non-interactive. Ordering it
      // without activation is sufficient for Chromium to resume producing a
      // compositor frame for Agent input or a low-frequency Overview capture.
      [host orderFront:nil];
      [nativeHandle release];
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
      [nativeHandle release];
    });
  };
  if (NSThread.isMainThread) update();
  else dispatch_async(dispatch_get_main_queue(), update);
}

bool UfoCefWindowIsCompositorAwake(void* cef_view_handle) {
  NSWindow* host = HostWindowForCefHandle(cef_view_handle);
  if (!host) return false;
  NSNumber* scheduled = [CompositorAwakeState() objectForKey:host];
  return scheduled ? scheduled.boolValue : host.isVisible;
}

void UfoCefProductControllerSet(void* cef_view_handle) {
  id retainedCefHandle = [(id)cef_view_handle retain];
  if (!retainedCefHandle) return;
  void (^install)(void) = ^{
    NSWindow* host = HostWindowForCefHandle(retainedCefHandle);
    if (!host) {
      [retainedCefHandle release];
      return;
    }
    if (gProductControllerWindow != host) {
      NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
      if (gProductControllerMoveObserver) {
        [center removeObserver:gProductControllerMoveObserver];
      }
      if (gProductControllerResizeObserver) {
        [center removeObserver:gProductControllerResizeObserver];
      }
      UnmountSpaceWindow(gMountedSpaceWindow);
      [gProductControllerWindow release];
      gProductControllerWindow = [host retain];
      gProductControllerMoveObserver = [center
          addObserverForName:NSWindowDidMoveNotification
                      object:host
                       queue:NSOperationQueue.mainQueue
                  usingBlock:^(NSNotification* note) {
        (void)note;
        SyncMountedSpaceFrame();
      }];
      gProductControllerResizeObserver = [center
          addObserverForName:NSWindowDidResizeNotification
                      object:host
                       queue:NSOperationQueue.mainQueue
                  usingBlock:^(NSNotification* note) {
        (void)note;
        SyncMountedSpaceFrame();
      }];
    }
    [retainedCefHandle release];
  };
  if (NSThread.isMainThread) install();
  else dispatch_async(dispatch_get_main_queue(), install);
}

void UfoCefProductControllerClear(void* cef_view_handle) {
  id retainedCefHandle = [(id)cef_view_handle retain];
  if (!retainedCefHandle) return;
  void (^clear)(void) = ^{
    NSWindow* host = HostWindowForCefHandle(retainedCefHandle);
    if (host && host == gProductControllerWindow) {
      NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
      if (gProductControllerMoveObserver) {
        [center removeObserver:gProductControllerMoveObserver];
      }
      if (gProductControllerResizeObserver) {
        [center removeObserver:gProductControllerResizeObserver];
      }
      gProductControllerMoveObserver = nil;
      gProductControllerResizeObserver = nil;
      UnmountSpaceWindow(gMountedSpaceWindow);
      [gProductControllerWindow release];
      gProductControllerWindow = nil;
    }
    [retainedCefHandle release];
  };
  if (NSThread.isMainThread) clear();
  else dispatch_async(dispatch_get_main_queue(), clear);
}

bool UfoCefWindowIsMountedInProductController(void* cef_view_handle) {
  NSWindow* host = HostWindowForCefHandle(cef_view_handle);
  // Chromium-owned Chrome Runtime windows can transiently report a nil
  // parentWindow even after addChildWindow:, especially when the product host
  // was launched by UFO's supervisor process. UFO's mount contract is the
  // retained mounted surface plus frame/order synchronization; requiring the
  // AppKit back-reference made a correctly in-place Space look detached to
  // presentation checks and triggered needless remount attempts.
  return host && gProductControllerWindow && host == gMountedSpaceWindow;
}

void UfoCefShellControlsSet(void* cef_view_handle, const char* presentation_socket) {
  id retainedCefHandle = [(id)cef_view_handle retain];
  const std::string socketValue = presentation_socket ?: "";
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow* host = HostWindowForCefHandle(retainedCefHandle);
    if (!host) {
      [retainedCefHandle release];
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
    [retainedCefHandle release];
  });
}

bool UfoCefShellControlsArePresentedForWindow(void* cef_view_handle) {
  NSWindow* host = HostWindowForCefHandle(cef_view_handle);
  return host && gShellPanel && gShellHostWindow == host &&
      gShellPanel.parentWindow == host && gShellPanel.alphaValue > 0.5 &&
      !gShellPanel.ignoresMouseEvents;
}

void UfoCefNativeSpaceWindowSet(void* cef_view_handle,
                                int space_id,
                                const char* presentation_socket,
                                bool agent_active) {
  id retainedCefHandle = [(id)cef_view_handle retain];
  const std::string socketValue = presentation_socket ?: "";
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow* host = HostWindowForCefHandle(retainedCefHandle);
    if (!host || space_id <= 0 || socketValue.empty()) {
      [retainedCefHandle release];
      return;
    }
    NSButton* closeButton = [host standardWindowButton:NSWindowCloseButton];
    if (!closeButton) {
      [retainedCefHandle release];
      return;
    }
    UfoNativeSpaceWindowBinding* binding =
        [NativeSpaceWindowBindings() objectForKey:host];
    if (!binding) {
      binding = [[[UfoNativeSpaceWindowBinding alloc] init] autorelease];
      binding.closeButton = closeButton;
      binding.originalTarget = closeButton.target;
      binding.originalAction = closeButton.action;
      binding.originalEnabled = closeButton.enabled;
      [NativeSpaceWindowBindings() setObject:binding forKey:host];
      closeButton.target = binding;
      closeButton.action = @selector(requestClose:);
    }
    binding.spaceId = space_id;
    binding.socketPath =
        [NSString stringWithUTF8String:socketValue.c_str()];
    binding.agentActive = agent_active;
    UpdateNativeSpaceCloseButton(binding);
    [retainedCefHandle release];
  });
}

void UfoCefNativeSpaceWindowSetAgentActive(void* cef_view_handle,
                                           bool agent_active) {
  id retainedCefHandle = [(id)cef_view_handle retain];
  if (!retainedCefHandle) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow* host = HostWindowForCefHandle(retainedCefHandle);
    UfoNativeSpaceWindowBinding* binding = host
        ? [NativeSpaceWindowBindings() objectForKey:host]
        : nil;
    if (binding) {
      binding.agentActive = agent_active;
      UpdateNativeSpaceCloseButton(binding);
    }
    [retainedCefHandle release];
  });
}

void UfoCefNativeSpaceWindowClear(void* cef_view_handle) {
  id retainedCefHandle = [(id)cef_view_handle retain];
  if (!retainedCefHandle) return;
  void (^clear)(void) = ^{
    RemoveNativeSpaceWindowBinding(
        HostWindowForCefHandle(retainedCefHandle));
    [retainedCefHandle release];
  };
  if (NSThread.isMainThread) clear();
  else dispatch_async(dispatch_get_main_queue(), clear);
}

bool UfoCefNativeSpaceWindowIsCloseRouted(void* cef_view_handle) {
  NSWindow* host = HostWindowForCefHandle(cef_view_handle);
  UfoNativeSpaceWindowBinding* binding = host
      ? [NativeSpaceWindowBindings() objectForKey:host]
      : nil;
  return binding && binding.closeButton &&
      binding.closeButton.target == binding &&
      binding.closeButton.action == @selector(requestClose:);
}

bool UfoCefNativeSpaceWindowIsCloseEnabled(void* cef_view_handle) {
  NSWindow* host = HostWindowForCefHandle(cef_view_handle);
  UfoNativeSpaceWindowBinding* binding = host
      ? [NativeSpaceWindowBindings() objectForKey:host]
      : nil;
  return binding && binding.closeButton && binding.closeButton.enabled;
}

void UfoCefSpaceControllerSet(void* cef_view_handle,
                              const char* space_name,
                              const char* profile_name,
                              const char* presentation_socket) {
  id retainedCefHandle = [(id)cef_view_handle retain];
  const std::string spaceValue = space_name ?: "Space";
  const std::string profileValue = profile_name ?: "Default";
  const std::string socketValue = presentation_socket ?: "";
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow* host = HostWindowForCefHandle(retainedCefHandle);
    if (!host) {
      [retainedCefHandle release];
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
    [retainedCefHandle release];
  });
}

void UfoCefChromeControlsClear(void* cef_view_handle) {
  id nativeHandle = [(id)cef_view_handle retain];
  if (!nativeHandle) return;
  void (^update)(void) = ^{
    NSWindow* host = HostWindowForCefHandle(nativeHandle);
    if (host) {
      [ChromeControlsMetadata() removeObjectForKey:host];
      if (gShellHostWindow == host) RemoveShellControls();
      if (gSpaceControllerHostWindow == host) RemoveSpaceController();
    }
    [nativeHandle release];
  };
  if (NSThread.isMainThread) update();
  else dispatch_async(dispatch_get_main_queue(), update);
}

bool UfoCefChromeControlsArePresentedForWindow(void* cef_view_handle) {
  NSWindow* host = HostWindowForCefHandle(cef_view_handle);
  if (!host) return false;
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
                        const char* title,
                        const char* detail,
                        int space_id,
                        const char* presentation_socket) {
  id retainedCefHandle = [(id)cef_view_handle retain];
  const std::string socketValue = presentation_socket ?: "";
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow* host = HostWindowForCefHandle(retainedCefHandle);
    if (!active || !host) {
      RemoveOverlay();
      [retainedCefHandle release];
      return;
    }
    if (gPanel && gHostWindow == host) {
      gPanel.overlayView.label = [NSString stringWithUTF8String:title ?: "Browser Agent"];
      gPanel.overlayView.detail = [NSString stringWithUTF8String:detail ?: "Agent 正在控制"];
      gPanel.overlayView.spaceId = space_id;
      gPanel.overlayView.socketPath = [NSString stringWithUTF8String:socketValue.c_str()];
      PositionOverlay();
      [gPanel orderFront:nil];
      [retainedCefHandle release];
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
    view.label = [NSString stringWithUTF8String:title ?: "Browser Agent"];
    view.detail = [NSString stringWithUTF8String:detail ?: "Agent 正在控制"];
    view.spaceId = space_id;
    view.socketPath = [NSString stringWithUTF8String:socketValue.c_str()];
    view.phase = 0.0;
    gPanel.overlayView = view;
    gPanel.contentView = view;
    [host addChildWindow:gPanel ordered:NSWindowAbove];
    [gPanel orderFront:nil];
    // The background remains static. At 10 FPS only the old/new sweep strips,
    // control bar, and short-lived pointer are invalidated; this preserves the
    // original gentle motion without turning the full window into a hot GPU
    // surface.
    gPanel.pulseTimer = [NSTimer scheduledTimerWithTimeInterval:1.0 / 10.0
                                                           repeats:YES
                                                             block:^(NSTimer* timer) {
      (void)timer;
      if (!gPanel) return;
      UfoOverlayView* overlay = gPanel.overlayView;
      const NSRect oldSweep = UfoOverlaySweepRect(overlay.bounds, overlay.phase);
      const NSRect oldPointer = UfoOverlayPointerRect(
          overlay, overlay.pointerX, overlay.pointerY);
      overlay.phase += 0.10;
      overlay.pointerX += (overlay.pointerTargetX - overlay.pointerX) * 0.55;
      overlay.pointerY += (overlay.pointerTargetY - overlay.pointerY) * 0.55;
      [overlay setNeedsDisplayInRect:NSUnionRect(
          NSInsetRect(oldSweep, -8.0, 0.0),
          NSInsetRect(UfoOverlaySweepRect(overlay.bounds, overlay.phase), -8.0, 0.0))];
      [overlay setNeedsDisplayInRect:UfoOverlayCapsuleRect(overlay.bounds)];
      if (overlay.pointerVisibleUntil > 0.0) {
        [overlay setNeedsDisplayInRect:NSUnionRect(
            oldPointer,
            UfoOverlayPointerRect(overlay, overlay.pointerX, overlay.pointerY))];
        if (overlay.pointerVisibleUntil <= [NSDate timeIntervalSinceReferenceDate]) {
          overlay.pointerVisibleUntil = 0.0;
        }
      }
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
    [retainedCefHandle release];
  });
}

void UfoAgentOverlayUpdateTask(void* cef_view_handle,
                               const char* title,
                               const char* detail) {
  id retainedCefHandle = [(id)cef_view_handle retain];
  const std::string titleValue = title ?: "Browser Agent";
  const std::string detailValue = detail ?: "Agent 正在控制";
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow* host = HostWindowForCefHandle(retainedCefHandle);
    if (host && gPanel && gHostWindow == host) {
      gPanel.overlayView.label = [NSString stringWithUTF8String:titleValue.c_str()];
      gPanel.overlayView.detail = [NSString stringWithUTF8String:detailValue.c_str()];
      [gPanel.overlayView setNeedsDisplayInRect:UfoOverlayCapsuleRect(gPanel.overlayView.bounds)];
    }
    [retainedCefHandle release];
  });
}

void UfoAgentOverlayShowPointer(void* cef_view_handle,
                                double x,
                                double y,
                                const char* label) {
  id retainedCefHandle = [(id)cef_view_handle retain];
  const std::string labelValue = label ?: "正在浏览网页";
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow* host = HostWindowForCefHandle(retainedCefHandle);
    if (host && gPanel && gHostWindow == host) {
      UfoOverlayView* overlay = gPanel.overlayView;
      NSRect oldRect = UfoOverlayPointerRect(overlay, overlay.pointerX, overlay.pointerY);
      const BOOL wasVisible = overlay.pointerVisibleUntil >
          [NSDate timeIntervalSinceReferenceDate];
      overlay.pointerLabel = [NSString stringWithUTF8String:labelValue.c_str()];
      overlay.pointerTargetX = MAX(0.0, (CGFloat)x);
      overlay.pointerTargetY = MAX(0.0, (CGFloat)y);
      if (!wasVisible) {
        overlay.pointerX = overlay.pointerTargetX;
        overlay.pointerY = overlay.pointerTargetY;
      }
      overlay.pointerVisibleUntil = [NSDate timeIntervalSinceReferenceDate] + 1.4;
      [overlay setNeedsDisplayInRect:NSUnionRect(
          oldRect,
          UfoOverlayPointerRect(overlay, overlay.pointerX, overlay.pointerY))];
    }
    [retainedCefHandle release];
  });
}

void UfoAgentOverlayClear(void* cef_view_handle) {
  (void)cef_view_handle;
  dispatch_async(dispatch_get_main_queue(), ^{ RemoveOverlay(); });
}

bool UfoAgentOverlayIsActiveForWindow(void* cef_view_handle) {
  NSWindow* host = HostWindowForCefHandle(cef_view_handle);
  return host && gPanel && gHostWindow == host &&
      gPanel.isVisible && gPanel.alphaValue > 0.5 && !gPanel.ignoresMouseEvents;
}

bool UfoAgentOverlayHasActionsForWindow(void* cef_view_handle) {
  if (!UfoAgentOverlayIsActiveForWindow(cef_view_handle)) return false;
  return gPanel.overlayView.spaceId > 0 && gPanel.overlayView.socketPath.length > 0;
}

bool UfoAgentOverlayOwnsWindow(void* ns_window) {
  return ns_window && gPanel && gPanel == (NSWindow*)ns_window;
}

bool UfoCefOpenChromeProfileWindow(const char* executable,
                                   const char* user_data_root,
                                   const char* profile_directory,
                                   const char* url,
                                   bool use_mock_keychain) {
  if (!executable || !*executable || !user_data_root || !*user_data_root ||
      !profile_directory || !*profile_directory || !url || !*url) {
    return false;
  }
  NSString* launchPath = [NSString stringWithUTF8String:executable];
  if (![NSFileManager.defaultManager isExecutableFileAtPath:launchPath]) {
    return false;
  }
  NSTask* task = [[NSTask alloc] init];
  task.launchPath = launchPath;
  NSMutableArray<NSString*>* arguments = [NSMutableArray arrayWithObjects:
      [NSString stringWithFormat:@"--url=%s", url],
      [NSString stringWithFormat:@"--user-data-dir=%s", user_data_root],
      [NSString stringWithFormat:@"--profile-directory=%s", profile_directory],
      @"--native-chrome-product-shell",
      @"--new-window",
      @"--ufo-profile-window-request",
      nil];
  if (use_mock_keychain) [arguments addObject:@"--use-mock-keychain"];
  task.arguments = arguments;
  NSMutableDictionary* environment =
      [[[NSProcessInfo processInfo] environment] mutableCopy];
  for (NSString* name in @[
      @"UFO_BROWSER_NATIVE_ATTACHED_HOST",
      @"UFO_BROWSER_ATTACHED_OVERVIEW_URL",
      @"UFO_BROWSER_OVERVIEW_CONTROL_SOCKET",
      @"UFO_BROWSER_PRESENTATION_SOCKET",
      @"UFO_BROWSER_SHARED_HOST_DEVTOOLS_SOCKET",
  ]) {
    [environment removeObjectForKey:name];
  }
  task.environment = environment;
  [environment release];
  task.standardOutput = [NSFileHandle fileHandleWithNullDevice];
  task.standardError = [NSFileHandle fileHandleWithNullDevice];
  NSError* error = nil;
  const bool launched = [task launchAndReturnError:&error];
  if (!launched) NSLog(@"UFO failed to forward Chrome Profile window: %@", error);
  [task release];
  return launched;
}
