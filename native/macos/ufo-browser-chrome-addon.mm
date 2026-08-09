#include <node_api.h>

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

namespace {

constexpr CGFloat kChromeHeight = 94.0;

void throwError(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
}

bool readString(napi_env env, napi_value value, std::string *result) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    return false;
  }
  result->resize(length);
  size_t copied = 0;
  if (napi_get_value_string_utf8(
          env, value, result->data(), length + 1, &copied) != napi_ok) {
    return false;
  }
  result->resize(copied);
  return true;
}

napi_value booleanValue(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

NSColor *color(CGFloat white, CGFloat alpha = 1.0) {
  return [NSColor colorWithWhite:white alpha:alpha];
}

NSImage *symbol(NSString *name, CGFloat pointSize, NSFontWeight weight) {
  NSImage *image = [NSImage imageWithSystemSymbolName:name
                             accessibilityDescription:nil];
  if (!image) return nil;
  NSImageSymbolConfiguration *configuration =
      [NSImageSymbolConfiguration configurationWithPointSize:pointSize
                                                      weight:weight];
  return [image imageWithSymbolConfiguration:configuration];
}

NSString *safeString(id value, NSString *fallback = @"") {
  return [value isKindOfClass:NSString.class] ? value : fallback;
}

NSInteger safeInteger(id value, NSInteger fallback = 0) {
  return [value respondsToSelector:@selector(integerValue)]
      ? [value integerValue]
      : fallback;
}

bool safeBool(id value) {
  return [value respondsToSelector:@selector(boolValue)] && [value boolValue];
}

}  // namespace

@interface UFOChromeTabItem : NSView
@property(nonatomic, copy) NSString *targetID;
@property(nonatomic, strong) NSButton *selectButton;
@property(nonatomic, strong) NSButton *closeButton;
@property(nonatomic, strong) NSView *identityDot;
- (instancetype)initWithTarget:(id)target;
- (void)updateTitle:(NSString *)title active:(BOOL)active enabled:(BOOL)enabled;
@end

@implementation UFOChromeTabItem

- (instancetype)initWithTarget:(id)target {
  self = [super initWithFrame:NSZeroRect];
  if (!self) return nil;
  self.wantsLayer = YES;
  self.layer.cornerCurve = kCACornerCurveContinuous;
  self.layer.cornerRadius = 12.0;

  _identityDot = [[NSView alloc] initWithFrame:NSZeroRect];
  _identityDot.wantsLayer = YES;
  _identityDot.layer.cornerRadius = 4.0;
  _identityDot.layer.backgroundColor =
      [NSColor colorWithRed:0.48 green:0.59 blue:0.56 alpha:0.42].CGColor;
  [self addSubview:_identityDot];

  _selectButton = [NSButton buttonWithTitle:@"" target:target action:@selector(activateTab:)];
  _selectButton.bordered = NO;
  _selectButton.alignment = NSTextAlignmentLeft;
  _selectButton.font = [NSFont systemFontOfSize:12.5 weight:NSFontWeightMedium];
  _selectButton.contentTintColor = color(0.20);
  _selectButton.lineBreakMode = NSLineBreakByTruncatingTail;
  _selectButton.focusRingType = NSFocusRingTypeNone;
  [self addSubview:_selectButton];

  _closeButton = [NSButton buttonWithImage:symbol(@"xmark", 10, NSFontWeightSemibold)
                                    target:target
                                    action:@selector(closeTab:)];
  _closeButton.bordered = NO;
  _closeButton.imagePosition = NSImageOnly;
  _closeButton.contentTintColor = color(0.36, 0.82);
  _closeButton.focusRingType = NSFocusRingTypeNone;
  _closeButton.toolTip = @"关闭标签页";
  [self addSubview:_closeButton];
  return self;
}

- (BOOL)isFlipped { return YES; }

- (void)layout {
  [super layout];
  const CGFloat height = NSHeight(self.bounds);
  self.identityDot.frame = NSMakeRect(11, (height - 8) / 2.0, 8, 8);
  self.closeButton.frame = NSMakeRect(NSWidth(self.bounds) - 31, 5, 26, height - 10);
  self.selectButton.frame = NSMakeRect(24, 0, MAX(20, NSWidth(self.bounds) - 56), height);
}

- (void)setTargetID:(NSString *)targetID {
  _targetID = [targetID copy];
  self.selectButton.identifier = targetID;
  self.closeButton.identifier = targetID;
}

- (void)updateTitle:(NSString *)title active:(BOOL)active enabled:(BOOL)enabled {
  self.selectButton.title = title.length > 0 ? title : @"新标签页";
  self.selectButton.enabled = enabled;
  self.closeButton.enabled = enabled;
  self.closeButton.hidden = !active;
  self.layer.backgroundColor = active ? color(0.935).CGColor : NSColor.clearColor.CGColor;
  self.layer.borderWidth = active ? 0.5 : 0.0;
  self.layer.borderColor = color(0.72, 0.28).CGColor;
  self.identityDot.layer.backgroundColor = active
      ? [NSColor colorWithRed:0.42 green:0.55 blue:0.51 alpha:0.68].CGColor
      : [NSColor colorWithRed:0.48 green:0.59 blue:0.56 alpha:0.34].CGColor;
}

@end

@interface UFOBrowserChromeView : NSView <NSSearchFieldDelegate>
@property(nonatomic, copy) void (^eventSink)(NSDictionary *event);
@property(nonatomic, weak) NSWindow *parentWindow;
@property(nonatomic, strong) NSButton *backButton;
@property(nonatomic, strong) NSButton *forwardButton;
@property(nonatomic, strong) NSButton *reloadButton;
@property(nonatomic, strong) NSButton *addTabButton;
@property(nonatomic, strong) NSButton *spacesButton;
@property(nonatomic, strong) NSButton *profileButton;
@property(nonatomic, strong) NSButton *titlebarMenuButton;
@property(nonatomic, strong) NSView *addressBackdrop;
@property(nonatomic, strong) NSView *spacesBackdrop;
@property(nonatomic, strong) NSSearchField *addressField;
@property(nonatomic, strong) NSView *separator;
@property(nonatomic, strong) NSMutableArray<UFOChromeTabItem *> *tabItems;
@property(nonatomic) BOOL addressEditing;
@property(nonatomic) BOOL controlled;
- (void)updateState:(NSDictionary *)state;
- (NSData *)pngRepresentation;
- (NSDictionary *)inspection;
- (void)focusAddress;
- (BOOL)handleMouseDownAtPoint:(NSPoint)point;
- (void)activateTab:(NSButton *)sender;
- (void)closeTab:(NSButton *)sender;
@end

@implementation UFOBrowserChromeView

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (!self) return nil;
  self.wantsLayer = YES;
  self.layer.backgroundColor = NSColor.clearColor.CGColor;
  self.layer.shadowColor = NSColor.blackColor.CGColor;
  self.layer.shadowOpacity = 0.035;
  self.layer.shadowRadius = 5.0;
  self.layer.shadowOffset = CGSizeMake(0, -1);
  _tabItems = [[NSMutableArray alloc] init];

  _titlebarMenuButton = [self symbolButton:@"chevron.down" action:@selector(showOverview:)];
  _titlebarMenuButton.toolTip = @"返回 Spaces";
  [self addSubview:_titlebarMenuButton];

  _backButton = [self symbolButton:@"chevron.left" action:@selector(goBack:)];
  _backButton.toolTip = @"后退";
  [self addSubview:_backButton];
  _forwardButton = [self symbolButton:@"chevron.right" action:@selector(goForward:)];
  _forwardButton.toolTip = @"前进";
  [self addSubview:_forwardButton];
  _reloadButton = [self symbolButton:@"arrow.clockwise" action:@selector(reload:)];
  _reloadButton.toolTip = @"刷新";
  [self addSubview:_reloadButton];

  _addTabButton = [self symbolButton:@"plus" action:@selector(newTab:)];
  _addTabButton.toolTip = @"新建标签页";
  [self addSubview:_addTabButton];

  _spacesBackdrop = [[NSView alloc] initWithFrame:NSZeroRect];
  _spacesBackdrop.wantsLayer = YES;
  _spacesBackdrop.layer.backgroundColor = color(0.965).CGColor;
  _spacesBackdrop.layer.cornerCurve = kCACornerCurveContinuous;
  _spacesBackdrop.layer.cornerRadius = 15.0;
  _spacesBackdrop.layer.borderWidth = 0.5;
  _spacesBackdrop.layer.borderColor = color(0.76, 0.24).CGColor;
  _spacesBackdrop.layer.shadowColor = NSColor.blackColor.CGColor;
  _spacesBackdrop.layer.shadowOpacity = 0.045;
  _spacesBackdrop.layer.shadowRadius = 5.0;
  _spacesBackdrop.layer.shadowOffset = CGSizeMake(0, -1);
  [self addSubview:_spacesBackdrop];

  _spacesButton = [NSButton buttonWithTitle:@"1" target:self action:@selector(showOverview:)];
  _spacesButton.bordered = NO;
  _spacesButton.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
  _spacesButton.contentTintColor = color(0.24);
  _spacesButton.focusRingType = NSFocusRingTypeNone;
  _spacesButton.wantsLayer = YES;
  _spacesButton.layer.backgroundColor = NSColor.clearColor.CGColor;
  _spacesButton.toolTip = @"返回 Spaces";
  [self addSubview:_spacesButton];

  _profileButton = [self symbolButton:@"person.crop.circle" action:@selector(showOverview:)];
  _profileButton.toolTip = @"Space 总览";
  [self addSubview:_profileButton];

  _addressBackdrop = [[NSView alloc] initWithFrame:NSZeroRect];
  _addressBackdrop.wantsLayer = YES;
  _addressBackdrop.layer.backgroundColor = color(0.948).CGColor;
  _addressBackdrop.layer.cornerCurve = kCACornerCurveContinuous;
  _addressBackdrop.layer.cornerRadius = 16.0;
  _addressBackdrop.layer.borderWidth = 0.5;
  _addressBackdrop.layer.borderColor = color(0.78, 0.24).CGColor;
  [self addSubview:_addressBackdrop];

  _addressField = [[NSSearchField alloc] initWithFrame:NSZeroRect];
  _addressField.delegate = self;
  _addressField.target = self;
  _addressField.action = @selector(submitAddress:);
  _addressField.placeholderString = @"在 Google 中搜索，或输入网址";
  _addressField.font = [NSFont systemFontOfSize:14 weight:NSFontWeightRegular];
  _addressField.bordered = NO;
  _addressField.drawsBackground = NO;
  _addressField.backgroundColor = NSColor.clearColor;
  _addressField.textColor = color(0.19);
  _addressField.focusRingType = NSFocusRingTypeNone;
  _addressField.wantsLayer = YES;
  _addressField.layer.backgroundColor = NSColor.clearColor.CGColor;
  [self addSubview:_addressField];

  _separator = [[NSView alloc] initWithFrame:NSZeroRect];
  _separator.wantsLayer = YES;
  _separator.layer.backgroundColor = color(0.82, 0.52).CGColor;
  [self addSubview:_separator];
  return self;
}

- (BOOL)isFlipped { return YES; }
- (BOOL)mouseDownCanMoveWindow { return NO; }

- (void)mouseDown:(NSEvent *)event {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  if ([self handleMouseDownAtPoint:point]) return;
  [super mouseDown:event];
}

- (BOOL)handleMouseDownAtPoint:(NSPoint)point {
  if (self.hidden || !NSPointInRect(point, self.bounds)) return NO;

  if (NSPointInRect(point, self.titlebarMenuButton.frame)) {
    [self.titlebarMenuButton performClick:nil];
    return YES;
  }
  if (NSPointInRect(point, self.spacesButton.frame)) {
    [self.spacesButton performClick:nil];
    return YES;
  }
  if (NSPointInRect(point, self.addTabButton.frame)) {
    [self.addTabButton performClick:nil];
    return YES;
  }
  if (NSPointInRect(point, self.backButton.frame)) {
    [self.backButton performClick:nil];
    return YES;
  }
  if (NSPointInRect(point, self.forwardButton.frame)) {
    [self.forwardButton performClick:nil];
    return YES;
  }
  if (NSPointInRect(point, self.reloadButton.frame)) {
    [self.reloadButton performClick:nil];
    return YES;
  }
  if (NSPointInRect(point, self.profileButton.frame)) {
    [self.profileButton performClick:nil];
    return YES;
  }
  if (NSPointInRect(point, self.addressField.frame)) {
    [self focusAddress];
    return YES;
  }

  for (UFOChromeTabItem *item in self.tabItems) {
    if (!NSPointInRect(point, item.frame)) continue;
    NSPoint itemPoint = NSMakePoint(
        point.x - NSMinX(item.frame), point.y - NSMinY(item.frame));
    if (!item.closeButton.hidden &&
        NSPointInRect(itemPoint, item.closeButton.frame)) {
      [item.closeButton performClick:nil];
    } else {
      [item.selectButton performClick:nil];
    }
    return YES;
  }

  if (point.y < 42 && point.x < 108 && self.parentWindow) {
    NSWindowButton buttonType = NSWindowCloseButton;
    if (point.x >= 76) buttonType = NSWindowZoomButton;
    else if (point.x >= 46) buttonType = NSWindowMiniaturizeButton;
    [[self.parentWindow standardWindowButton:buttonType] performClick:nil];
    return YES;
  }
  return NO;
}

- (NSButton *)symbolButton:(NSString *)name action:(SEL)action {
  NSButton *button = [NSButton buttonWithImage:symbol(name, 14, NSFontWeightMedium)
                                        target:self
                                        action:action];
  button.bordered = NO;
  button.imagePosition = NSImageOnly;
  button.contentTintColor = color(0.31, 0.90);
  button.focusRingType = NSFocusRingTypeNone;
  return button;
}

- (void)layout {
  [super layout];
  const CGFloat width = NSWidth(self.bounds);
  self.titlebarMenuButton.frame = NSMakeRect(84, 7, 28, 28);
  self.spacesBackdrop.frame = NSMakeRect(width - 48, 6, 34, 30);
  self.spacesButton.frame = NSMakeRect(width - 48, 6, 34, 30);

  const CGFloat tabsLeft = 120;
  const CGFloat tabsRight = width - 58;
  const CGFloat tabsWidth = MAX(80, tabsRight - tabsLeft - 35);
  const NSUInteger count = self.tabItems.count;
  const CGFloat itemWidth = count > 0
      ? MIN(250.0, MAX(118.0, (tabsWidth - MAX(0, (NSInteger)count - 1) * 4.0) / count))
      : 0;
  CGFloat tabX = tabsLeft;
  for (UFOChromeTabItem *item in self.tabItems) {
    item.frame = NSMakeRect(tabX, 4, itemWidth, 34);
    tabX += itemWidth + 4;
  }
  self.addTabButton.frame = NSMakeRect(MIN(tabX + 2, tabsRight), 7, 28, 28);

  const CGFloat toolbarY = 54;
  self.backButton.frame = NSMakeRect(16, toolbarY + 3, 30, 30);
  self.forwardButton.frame = NSMakeRect(52, toolbarY + 3, 30, 30);
  self.reloadButton.frame = NSMakeRect(88, toolbarY + 3, 30, 30);
  self.profileButton.frame = NSMakeRect(width - 48, toolbarY + 3, 32, 30);
  self.addressBackdrop.frame = NSMakeRect(
      126,
      toolbarY + 2,
      MAX(120, width - 126 - 60),
      32);
  self.addressField.frame = NSMakeRect(
      130,
      toolbarY + 2,
      MAX(112, width - 130 - 64),
      32);
  self.separator.frame = NSMakeRect(0, kChromeHeight - 1, width, 1);
}

- (void)updateState:(NSDictionary *)state {
  NSDictionary *space = [state[@"space"] isKindOfClass:NSDictionary.class]
      ? state[@"space"]
      : @{};
  NSArray *tabs = [space[@"tabs"] isKindOfClass:NSArray.class] ? space[@"tabs"] : @[];
  NSString *activeTarget = safeString(space[@"activeTabId"]);
  self.controlled = [safeString(space[@"ownership"]) isEqualToString:@"agent"] &&
      [safeString(space[@"lifecycle"]) isEqualToString:@"active"];

  while (self.tabItems.count > tabs.count) {
    UFOChromeTabItem *item = self.tabItems.lastObject;
    [item removeFromSuperview];
    [self.tabItems removeLastObject];
  }
  while (self.tabItems.count < tabs.count) {
    UFOChromeTabItem *item = [[UFOChromeTabItem alloc] initWithTarget:self];
    [self.tabItems addObject:item];
    [self addSubview:item positioned:NSWindowAbove relativeTo:nil];
  }
  [tabs enumerateObjectsUsingBlock:^(id value, NSUInteger index, BOOL *stop) {
    NSDictionary *tab = [value isKindOfClass:NSDictionary.class] ? value : @{};
    UFOChromeTabItem *item = self.tabItems[index];
    NSString *targetID = safeString(tab[@"targetId"]);
    item.targetID = targetID;
    NSString *title = safeString(tab[@"title"], @"新标签页");
    [item updateTitle:title
               active:[targetID isEqualToString:activeTarget]
              enabled:!self.controlled];
  }];

  self.spacesButton.title = [NSString stringWithFormat:@"%ld",
      (long)MAX(1, safeInteger(state[@"spaceCount"], 1))];
  self.backButton.enabled = !self.controlled && safeBool(state[@"canGoBack"]);
  self.forwardButton.enabled = !self.controlled && safeBool(state[@"canGoForward"]);
  self.reloadButton.enabled = !self.controlled;
  self.addTabButton.enabled = !self.controlled;
  self.addressField.editable = !self.controlled;
  self.addressField.selectable = !self.controlled;
  self.addressBackdrop.layer.backgroundColor = self.controlled
      ? [NSColor colorWithRed:0.94 green:0.95 blue:0.98 alpha:1.0].CGColor
      : color(0.948).CGColor;
  self.layer.borderWidth = self.controlled ? 1.0 : 0.0;
  self.layer.borderColor = self.controlled
      ? [NSColor colorWithRed:0.39 green:0.55 blue:0.94 alpha:0.42].CGColor
      : NSColor.clearColor.CGColor;

  if (!self.addressEditing) {
    NSDictionary *activeTab = [state[@"activeTab"] isKindOfClass:NSDictionary.class]
        ? state[@"activeTab"]
        : @{};
    NSString *url = safeString(activeTab[@"url"]);
    if ([url isEqualToString:@"https://www.google.com/"] ||
        [url isEqualToString:@"https://google.com/"]) {
      self.addressField.stringValue = @"";
    } else {
      self.addressField.stringValue = url;
    }
  }
  [self setNeedsLayout:YES];
}

- (NSData *)pngRepresentation {
  if (self.bounds.size.width <= 0 || self.bounds.size.height <= 0) return nil;
  NSBitmapImageRep *bitmap = [self bitmapImageRepForCachingDisplayInRect:self.bounds];
  if (!bitmap) return nil;
  [self cacheDisplayInRect:self.bounds toBitmapImageRep:bitmap];
  return [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

- (NSDictionary *)inspection {
  NSPoint titleLocalPoint = NSMakePoint(NSMidX(self.titlebarMenuButton.frame),
                                       NSMidY(self.titlebarMenuButton.frame));
  NSPoint addressLocalPoint = NSMakePoint(NSMidX(self.addressField.frame),
                                         NSMidY(self.addressField.frame));
  NSPoint titlePoint = self.superview
      ? [self convertPoint:titleLocalPoint toView:self.superview]
      : titleLocalPoint;
  NSPoint addressPoint = self.superview
      ? [self convertPoint:addressLocalPoint toView:self.superview]
      : addressLocalPoint;
  NSView *titleHit = [self hitTest:titlePoint];
  NSView *addressHit = [self hitTest:addressPoint];
  return @{
    @"visible": @(!self.hidden && self.window.isVisible),
    @"tabCount": @(self.tabItems.count),
    @"spacesCount": self.spacesButton.title ?: @"",
    @"addressValue": self.addressField.stringValue ?: @"",
    @"addressFocused": @(self.addressField.currentEditor != nil),
    @"addressFrame": @{
      @"x": @(NSMinX(self.addressBackdrop.frame)),
      @"y": @(NSMinY(self.addressBackdrop.frame)),
      @"width": @(NSWidth(self.addressBackdrop.frame)),
      @"height": @(NSHeight(self.addressBackdrop.frame)),
    },
    @"titleHitClass": titleHit ? NSStringFromClass(titleHit.class) : @"",
    @"addressHitClass": addressHit ? NSStringFromClass(addressHit.class) : @"",
  };
}

- (void)focusAddress {
  if (!self.addressField.editable || !self.window) return;
  [self.window makeFirstResponder:self.addressField];
  [self.addressField selectText:nil];
}

- (void)emit:(NSString *)type extra:(NSDictionary *)extra {
  if (!self.eventSink) return;
  NSMutableDictionary *payload = [NSMutableDictionary dictionaryWithObject:type forKey:@"type"];
  if (extra) [payload addEntriesFromDictionary:extra];
  self.eventSink(payload);
}

- (void)activateTab:(NSButton *)sender {
  [self emit:@"activate-tab" extra:@{ @"targetId": sender.identifier ?: @"" }];
}
- (void)closeTab:(NSButton *)sender {
  [self emit:@"close-tab" extra:@{ @"targetId": sender.identifier ?: @"" }];
}
- (void)goBack:(id)sender { [self emit:@"back" extra:nil]; }
- (void)goForward:(id)sender { [self emit:@"forward" extra:nil]; }
- (void)reload:(id)sender { [self emit:@"reload" extra:nil]; }
- (void)newTab:(id)sender { [self emit:@"new-tab" extra:nil]; }
- (void)showOverview:(id)sender { [self emit:@"show-overview" extra:nil]; }
- (void)submitAddress:(id)sender {
  NSString *value = [self.addressField.stringValue
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (value.length == 0) return;
  [self.window makeFirstResponder:nil];
  self.addressEditing = NO;
  [self emit:@"navigate" extra:@{ @"value": value }];
}

- (void)controlTextDidBeginEditing:(NSNotification *)notification {
  self.addressEditing = YES;
}
- (void)controlTextDidEndEditing:(NSNotification *)notification {
  self.addressEditing = NO;
}

@end

@interface UFOChromeBridge : NSObject
@property(nonatomic) napi_env env;
@property(nonatomic) napi_ref callback;
@property(nonatomic, weak) NSView *hostView;
@property(nonatomic, weak) NSWindow *parentWindow;
@property(nonatomic, strong) UFOBrowserChromeView *chromeView;
@property(nonatomic, strong) id mouseMonitor;
- (void)emit:(NSDictionary *)event;
- (void)attachToHost;
- (void)updateChromeFrame;
@end

@implementation UFOChromeBridge

- (void)emit:(NSDictionary *)event {
  if (!self.env || !self.callback || ![NSJSONSerialization isValidJSONObject:event]) return;
  NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  if (!data) return;
  NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (!json) return;
  napi_handle_scope scope;
  if (napi_open_handle_scope(self.env, &scope) != napi_ok) return;
  napi_value callbackValue;
  napi_value global;
  napi_value argument;
  napi_get_reference_value(self.env, self.callback, &callbackValue);
  napi_get_global(self.env, &global);
  napi_create_string_utf8(self.env, json.UTF8String, NAPI_AUTO_LENGTH, &argument);
  napi_value result;
  napi_call_function(self.env, global, callbackValue, 1, &argument, &result);
  napi_close_handle_scope(self.env, scope);
}

- (void)attachToHost {
  NSView *host = self.hostView;
  if (!host || !self.chromeView) return;
  if (self.chromeView.superview != host) {
    [self.chromeView removeFromSuperview];
    [host addSubview:self.chromeView positioned:NSWindowAbove relativeTo:nil];
  }
  [self updateChromeFrame];
}

- (void)updateChromeFrame {
  NSView *host = self.hostView;
  if (!host || !self.chromeView) return;
  const CGFloat y = host.isFlipped
      ? 0.0
      : MAX(0.0, NSHeight(host.bounds) - kChromeHeight);
  self.chromeView.frame = NSMakeRect(
      0,
      y,
      NSWidth(host.bounds),
      MIN(kChromeHeight, NSHeight(host.bounds)));
}

@end

static UFOChromeBridge *chromeBridge;

napi_value installChrome(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 2) {
    throwError(env, "installChrome requires a native window handle and callback");
    return nullptr;
  }
  void *handleBytes = nullptr;
  size_t handleLength = 0;
  napi_valuetype callbackType;
  if (napi_get_buffer_info(env, argv[0], &handleBytes, &handleLength) != napi_ok ||
      handleLength < sizeof(void *) ||
      napi_typeof(env, argv[1], &callbackType) != napi_ok ||
      callbackType != napi_function) {
    throwError(env, "installChrome received invalid arguments");
    return nullptr;
  }
  uintptr_t nativePointer = 0;
  std::memcpy(&nativePointer, handleBytes, sizeof(nativePointer));
  NSView *host = (__bridge NSView *)reinterpret_cast<void *>(nativePointer);
  if (!host) return booleanValue(env, false);

  if (chromeBridge.callback) {
    napi_delete_reference(chromeBridge.env, chromeBridge.callback);
  }
  if (chromeBridge.mouseMonitor) {
    [NSEvent removeMonitor:chromeBridge.mouseMonitor];
  }
  [chromeBridge.chromeView removeFromSuperview];
  chromeBridge = [[UFOChromeBridge alloc] init];
  chromeBridge.env = env;
  napi_ref callback = nullptr;
  napi_create_reference(env, argv[1], 1, &callback);
  chromeBridge.callback = callback;
  chromeBridge.hostView = host;
  chromeBridge.parentWindow = host.window;
  if (!chromeBridge.parentWindow) return booleanValue(env, false);
  UFOBrowserChromeView *view = [[UFOBrowserChromeView alloc]
      initWithFrame:NSMakeRect(0, 0, NSWidth(host.bounds), kChromeHeight)];
  view.autoresizingMask = NSViewWidthSizable |
      (host.isFlipped ? NSViewMaxYMargin : NSViewMinYMargin);
  view.parentWindow = chromeBridge.parentWindow;
  __weak UFOChromeBridge *weakBridge = chromeBridge;
  view.eventSink = ^(NSDictionary *event) {
    [weakBridge emit:event];
  };
  chromeBridge.chromeView = view;
  view.hidden = YES;
  [chromeBridge attachToHost];
  __weak UFOChromeBridge *weakMouseBridge = chromeBridge;
  chromeBridge.mouseMonitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown
      handler:^NSEvent *(NSEvent *event) {
        UFOChromeBridge *bridge = weakMouseBridge;
        UFOBrowserChromeView *chrome = bridge.chromeView;
        if (!bridge || !chrome || chrome.hidden ||
            event.window != bridge.parentWindow) {
          return event;
        }
        NSPoint point = [chrome convertPoint:event.locationInWindow fromView:nil];
        return [chrome handleMouseDownAtPoint:point] ? nil : event;
      }];
  return booleanValue(env, true);
}

napi_value updateChrome(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string jsonValue;
  if (argc < 1 || !readString(env, argv[0], &jsonValue) || !chromeBridge.chromeView) {
    return booleanValue(env, false);
  }
  NSData *data = [NSData dataWithBytes:jsonValue.data() length:jsonValue.size()];
  id state = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![state isKindOfClass:NSDictionary.class]) return booleanValue(env, false);
  [chromeBridge.chromeView updateState:state];
  if (!chromeBridge.chromeView.hidden) [chromeBridge updateChromeFrame];
  return booleanValue(env, true);
}

napi_value setChromeVisible(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool visible = false;
  if (argc < 1 || napi_get_value_bool(env, argv[0], &visible) != napi_ok ||
      !chromeBridge.chromeView) {
    return booleanValue(env, false);
  }
  chromeBridge.chromeView.hidden = !visible;
  if (visible) {
    [chromeBridge attachToHost];
    [chromeBridge.chromeView setNeedsDisplay:YES];
  }
  return booleanValue(env, true);
}

napi_value focusChromeAddress(napi_env env, napi_callback_info info) {
  if (!chromeBridge.chromeView) return booleanValue(env, false);
  [chromeBridge.chromeView focusAddress];
  return booleanValue(env, true);
}

napi_value captureChrome(napi_env env, napi_callback_info info) {
  if (!chromeBridge.chromeView || chromeBridge.chromeView.hidden ||
      !chromeBridge.chromeView.window.isVisible) {
    napi_value result;
    napi_get_null(env, &result);
    return result;
  }
  NSData *png = [chromeBridge.chromeView pngRepresentation];
  if (!png || png.length == 0) {
    napi_value result;
    napi_get_null(env, &result);
    return result;
  }
  napi_value buffer;
  napi_create_buffer_copy(env, png.length, png.bytes, nullptr, &buffer);
  return buffer;
}

napi_value inspectChrome(napi_env env, napi_callback_info info) {
  if (!chromeBridge.chromeView) {
    napi_value result;
    napi_get_null(env, &result);
    return result;
  }
  NSDictionary *inspection = [chromeBridge.chromeView inspection];
  NSData *data = [NSJSONSerialization dataWithJSONObject:inspection options:0 error:nil];
  NSString *json = data
      ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]
      : nil;
  if (!json) {
    napi_value result;
    napi_get_null(env, &result);
    return result;
  }
  napi_value result;
  napi_create_string_utf8(env, json.UTF8String, NAPI_AUTO_LENGTH, &result);
  return result;
}

napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"installChrome", nullptr, installChrome, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"updateChrome", nullptr, updateChrome, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"setChromeVisible", nullptr, setChromeVisible, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"focusChromeAddress", nullptr, focusChromeAddress, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"captureChrome", nullptr, captureChrome, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"inspectChrome", nullptr, inspectChrome, nullptr, nullptr, nullptr,
       napi_default, nullptr},
  };
  napi_define_properties(
      env,
      exports,
      sizeof(properties) / sizeof(properties[0]),
      properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
