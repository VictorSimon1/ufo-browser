#include <node_api.h>

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

namespace {

constexpr CGFloat kChromeHeight = 94.0;
constexpr CGFloat kTitlebarHeight = 54.0;

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

@interface UFOChromeRoundButton : NSButton
@property(nonatomic, strong) NSTrackingArea *hoverTrackingArea;
@property(nonatomic) BOOL pointerInside;
- (instancetype)initWithSymbol:(NSString *)symbolName
                     pointSize:(CGFloat)pointSize
                        target:(id)target
                        action:(SEL)action;
@end

@implementation UFOChromeRoundButton

- (instancetype)initWithSymbol:(NSString *)symbolName
                     pointSize:(CGFloat)pointSize
                        target:(id)target
                        action:(SEL)action {
  self = [super initWithFrame:NSZeroRect];
  if (!self) return nil;
  self.target = target;
  self.action = action;
  self.image = symbol(symbolName, pointSize, NSFontWeightMedium);
  self.imagePosition = NSImageOnly;
  self.imageScaling = NSImageScaleProportionallyDown;
  self.bordered = NO;
  self.focusRingType = NSFocusRingTypeNone;
  self.contentTintColor = color(0.45);
  self.wantsLayer = YES;
  self.layer.cornerCurve = kCACornerCurveContinuous;
  self.layer.borderWidth = 0.5;
  self.layer.borderColor = color(0.84, 0.42).CGColor;
  [self refreshAppearance];
  return self;
}

- (void)layout {
  [super layout];
  self.layer.cornerRadius = MIN(NSWidth(self.bounds), NSHeight(self.bounds)) / 2.0;
}

- (void)updateTrackingAreas {
  [super updateTrackingAreas];
  if (self.hoverTrackingArea) [self removeTrackingArea:self.hoverTrackingArea];
  self.hoverTrackingArea = [[NSTrackingArea alloc]
      initWithRect:NSZeroRect
           options:NSTrackingMouseEnteredAndExited |
                   NSTrackingActiveInKeyWindow |
                   NSTrackingInVisibleRect
             owner:self
          userInfo:nil];
  [self addTrackingArea:self.hoverTrackingArea];
}

- (void)mouseEntered:(NSEvent *)event {
  self.pointerInside = YES;
  [self refreshAppearance];
}

- (void)mouseExited:(NSEvent *)event {
  self.pointerInside = NO;
  [self refreshAppearance];
}

- (void)setHighlighted:(BOOL)highlighted {
  [super setHighlighted:highlighted];
  [self refreshAppearance];
}

- (void)setEnabled:(BOOL)enabled {
  [super setEnabled:enabled];
  [self refreshAppearance];
}

- (void)refreshAppearance {
  if (!self.layer) return;
  CGFloat fill = self.isHighlighted ? 0.93 : (self.pointerInside ? 0.965 : 0.985);
  self.layer.backgroundColor = color(fill).CGColor;
  self.contentTintColor = self.enabled ? color(0.56) : color(0.74);
}

@end

@interface UFOChromeHoverButton : NSButton
@property(nonatomic, strong) NSTrackingArea *hoverTrackingArea;
@property(nonatomic) BOOL pointerInside;
- (instancetype)initWithSymbol:(NSString *)symbolName
                     pointSize:(CGFloat)pointSize
                        target:(id)target
                        action:(SEL)action;
- (void)refreshAppearance;
@end

@implementation UFOChromeHoverButton

- (instancetype)initWithSymbol:(NSString *)symbolName
                     pointSize:(CGFloat)pointSize
                        target:(id)target
                        action:(SEL)action {
  self = [super initWithFrame:NSZeroRect];
  if (!self) return nil;
  self.target = target;
  self.action = action;
  self.image = symbol(symbolName, pointSize, NSFontWeightMedium);
  self.imagePosition = NSImageOnly;
  self.imageScaling = NSImageScaleProportionallyDown;
  self.bordered = NO;
  self.focusRingType = NSFocusRingTypeNone;
  self.contentTintColor = color(0.31, 0.88);
  self.wantsLayer = YES;
  self.layer.cornerCurve = kCACornerCurveContinuous;
  [self refreshAppearance];
  return self;
}

- (void)layout {
  [super layout];
  self.layer.cornerRadius = MIN(NSWidth(self.bounds), NSHeight(self.bounds)) / 2.0;
}

- (void)updateTrackingAreas {
  [super updateTrackingAreas];
  if (self.hoverTrackingArea) [self removeTrackingArea:self.hoverTrackingArea];
  self.hoverTrackingArea = [[NSTrackingArea alloc]
      initWithRect:NSZeroRect
           options:NSTrackingMouseEnteredAndExited |
                   NSTrackingActiveInKeyWindow |
                   NSTrackingInVisibleRect
             owner:self
          userInfo:nil];
  [self addTrackingArea:self.hoverTrackingArea];
}

- (void)mouseEntered:(NSEvent *)event {
  self.pointerInside = YES;
  [self refreshAppearance];
}

- (void)mouseExited:(NSEvent *)event {
  self.pointerInside = NO;
  [self refreshAppearance];
}

- (void)setHighlighted:(BOOL)highlighted {
  [super setHighlighted:highlighted];
  [self refreshAppearance];
}

- (void)setEnabled:(BOOL)enabled {
  [super setEnabled:enabled];
  [self refreshAppearance];
}

- (void)refreshAppearance {
  if (!self.layer) return;
  if (self.isHighlighted) {
    self.layer.backgroundColor = color(0.875).CGColor;
  } else if (self.state == NSControlStateValueOn) {
    self.layer.backgroundColor = color(0.90).CGColor;
  } else if (self.pointerInside) {
    self.layer.backgroundColor = color(0.94).CGColor;
  } else {
    self.layer.backgroundColor = NSColor.clearColor.CGColor;
  }
  self.contentTintColor = self.enabled ? color(0.27, 0.90) : color(0.70);
}

@end

@interface UFOFlippedView : NSView
@end

@implementation UFOFlippedView
- (BOOL)isFlipped { return YES; }
@end

@interface UFOTabSearchCellView : NSTableCellView
@property(nonatomic, strong) NSView *iconBackdrop;
@property(nonatomic, strong) NSImageView *siteIcon;
@property(nonatomic, strong) NSTextField *titleLabel;
@property(nonatomic, strong) NSTextField *subtitleLabel;
@property(nonatomic, strong) UFOChromeHoverButton *closeButton;
@property(nonatomic, copy) NSString *targetID;
- (instancetype)initWithCloseTarget:(id)target action:(SEL)action;
- (void)configureWithTab:(NSDictionary *)tab active:(BOOL)active;
@end

@implementation UFOTabSearchCellView

- (instancetype)initWithCloseTarget:(id)target action:(SEL)action {
  self = [super initWithFrame:NSZeroRect];
  if (!self) return nil;
  self.wantsLayer = YES;
  self.layer.cornerCurve = kCACornerCurveContinuous;
  self.layer.cornerRadius = 8;

  _iconBackdrop = [[NSView alloc] initWithFrame:NSZeroRect];
  _iconBackdrop.wantsLayer = YES;
  _iconBackdrop.layer.backgroundColor = color(0.955).CGColor;
  _iconBackdrop.layer.cornerCurve = kCACornerCurveContinuous;
  _iconBackdrop.layer.cornerRadius = 9;
  [self addSubview:_iconBackdrop];

  _siteIcon = [[NSImageView alloc] initWithFrame:NSZeroRect];
  _siteIcon.image = symbol(@"globe", 15, NSFontWeightMedium);
  _siteIcon.imageScaling = NSImageScaleProportionallyDown;
  _siteIcon.contentTintColor = color(0.48);
  [self addSubview:_siteIcon];

  _titleLabel = [NSTextField labelWithString:@""];
  _titleLabel.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
  _titleLabel.textColor = color(0.18);
  _titleLabel.lineBreakMode = NSLineBreakByTruncatingTail;
  [self addSubview:_titleLabel];

  _subtitleLabel = [NSTextField labelWithString:@""];
  _subtitleLabel.font = [NSFont systemFontOfSize:11.5 weight:NSFontWeightRegular];
  _subtitleLabel.textColor = color(0.42);
  _subtitleLabel.lineBreakMode = NSLineBreakByTruncatingTail;
  [self addSubview:_subtitleLabel];

  _closeButton = [[UFOChromeHoverButton alloc]
      initWithSymbol:@"xmark"
           pointSize:11
              target:target
              action:action];
  _closeButton.toolTip = @"关闭标签页";
  [self addSubview:_closeButton];
  return self;
}

- (BOOL)isFlipped { return YES; }

- (void)layout {
  [super layout];
  const CGFloat width = NSWidth(self.bounds);
  self.iconBackdrop.frame = NSMakeRect(8, 7, 42, 42);
  self.siteIcon.frame = NSMakeRect(20, 19, 18, 18);
  self.titleLabel.frame = NSMakeRect(62, 8, MAX(70, width - 108), 20);
  self.subtitleLabel.frame = NSMakeRect(62, 29, MAX(70, width - 108), 18);
  self.closeButton.frame = NSMakeRect(width - 38, 14, 28, 28);
}

- (void)setTargetID:(NSString *)targetID {
  _targetID = [targetID copy];
  self.closeButton.identifier = targetID;
}

- (void)configureWithTab:(NSDictionary *)tab active:(BOOL)active {
  self.targetID = safeString(tab[@"targetId"]);
  self.titleLabel.stringValue = safeString(tab[@"title"], @"新标签页");
  NSString *url = safeString(tab[@"url"]);
  NSURL *parsed = [NSURL URLWithString:url];
  self.subtitleLabel.stringValue = parsed.host.length > 0 ? parsed.host : url;
  self.layer.backgroundColor = active ? color(0.91).CGColor : NSColor.clearColor.CGColor;
}

@end

@interface UFOTabSearchViewController
    : NSViewController <NSSearchFieldDelegate, NSTableViewDelegate, NSTableViewDataSource>
@property(nonatomic, strong) NSSearchField *searchField;
@property(nonatomic, strong) NSTableView *tableView;
@property(nonatomic, strong) NSArray<NSDictionary *> *tabs;
@property(nonatomic, strong) NSArray<NSDictionary *> *filteredTabs;
@property(nonatomic, copy) NSString *activeTargetID;
@property(nonatomic, copy) void (^activateTarget)(NSString *targetID);
@property(nonatomic, copy) void (^closeTarget)(NSString *targetID);
- (void)updateTabs:(NSArray<NSDictionary *> *)tabs activeTargetID:(NSString *)activeTargetID;
@end

@implementation UFOTabSearchViewController

- (void)loadView {
  UFOFlippedView *root = [[UFOFlippedView alloc]
      initWithFrame:NSMakeRect(0, 0, 360, 420)];
  root.wantsLayer = YES;
  root.layer.backgroundColor = NSColor.windowBackgroundColor.CGColor;
  self.view = root;

  _searchField = [[NSSearchField alloc] initWithFrame:NSMakeRect(18, 14, 324, 38)];
  _searchField.placeholderString = @"搜索标签页";
  _searchField.font = [NSFont systemFontOfSize:14 weight:NSFontWeightRegular];
  _searchField.delegate = self;
  [root addSubview:_searchField];

  NSView *separator = [[NSView alloc] initWithFrame:NSMakeRect(0, 64, 360, 1)];
  separator.wantsLayer = YES;
  separator.layer.backgroundColor = color(0.84, 0.62).CGColor;
  [root addSubview:separator];

  NSTextField *heading = [NSTextField labelWithString:@"打开的标签页"];
  heading.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
  heading.textColor = color(0.28);
  heading.frame = NSMakeRect(20, 81, 300, 22);
  [root addSubview:heading];

  NSScrollView *scroll = [[NSScrollView alloc]
      initWithFrame:NSMakeRect(12, 110, 336, 298)];
  scroll.drawsBackground = NO;
  scroll.hasVerticalScroller = YES;
  scroll.autohidesScrollers = YES;
  scroll.borderType = NSNoBorder;

  _tableView = [[NSTableView alloc] initWithFrame:scroll.bounds];
  NSTableColumn *column = [[NSTableColumn alloc] initWithIdentifier:@"tab"];
  column.width = 332;
  [_tableView addTableColumn:column];
  _tableView.headerView = nil;
  _tableView.backgroundColor = NSColor.clearColor;
  _tableView.intercellSpacing = NSMakeSize(0, 2);
  _tableView.rowHeight = 56;
  _tableView.selectionHighlightStyle = NSTableViewSelectionHighlightStyleNone;
  _tableView.delegate = self;
  _tableView.dataSource = self;
  scroll.documentView = _tableView;
  [root addSubview:scroll];
}

- (void)updateTabs:(NSArray<NSDictionary *> *)tabs activeTargetID:(NSString *)activeTargetID {
  self.tabs = [tabs copy] ?: @[];
  self.activeTargetID = [activeTargetID copy] ?: @"";
  (void)self.view;
  [self applyFilter];
}

- (void)applyFilter {
  NSString *query = [self.searchField.stringValue
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (query.length == 0) {
    self.filteredTabs = self.tabs ?: @[];
  } else {
    NSPredicate *predicate = [NSPredicate predicateWithBlock:^BOOL(
        NSDictionary *tab, NSDictionary *bindings) {
      NSString *haystack = [NSString stringWithFormat:@"%@ %@",
          safeString(tab[@"title"]), safeString(tab[@"url"])];
      return [haystack rangeOfString:query options:NSCaseInsensitiveSearch].location != NSNotFound;
    }];
    self.filteredTabs = [self.tabs filteredArrayUsingPredicate:predicate];
  }
  [self.tableView reloadData];
}

- (NSInteger)numberOfRowsInTableView:(NSTableView *)tableView {
  return self.filteredTabs.count;
}

- (NSView *)tableView:(NSTableView *)tableView
    viewForTableColumn:(NSTableColumn *)tableColumn
                   row:(NSInteger)row {
  if (row < 0 || row >= (NSInteger)self.filteredTabs.count) return nil;
  NSDictionary *tab = self.filteredTabs[(NSUInteger)row];
  UFOTabSearchCellView *cell = [[UFOTabSearchCellView alloc]
      initWithCloseTarget:self
                  action:@selector(closeTabRow:)];
  NSString *targetID = safeString(tab[@"targetId"]);
  [cell configureWithTab:tab active:[targetID isEqualToString:self.activeTargetID]];
  return cell;
}

- (void)tableViewSelectionDidChange:(NSNotification *)notification {
  NSInteger row = self.tableView.selectedRow;
  if (row < 0 || row >= (NSInteger)self.filteredTabs.count) return;
  NSString *targetID = safeString(self.filteredTabs[(NSUInteger)row][@"targetId"]);
  if (targetID.length > 0 && self.activateTarget) self.activateTarget(targetID);
}

- (void)closeTabRow:(NSButton *)sender {
  NSString *targetID = sender.identifier;
  if (targetID.length > 0 && self.closeTarget) self.closeTarget(targetID);
}

- (void)controlTextDidChange:(NSNotification *)notification {
  [self applyFilter];
}

@end

@interface UFOChromeAddressFieldCell : NSTextFieldCell
- (NSRect)centeredTextRectForBounds:(NSRect)rect;
@end

@implementation UFOChromeAddressFieldCell

- (NSRect)centeredTextRectForBounds:(NSRect)rect {
  NSFont *font = self.font ?: [NSFont systemFontOfSize:14];
  const CGFloat textHeight = MIN(NSHeight(rect),
      ceil(font.ascender - font.descender + font.leading));
  const CGFloat y = floor((NSHeight(rect) - textHeight) / 2.0);
  return NSMakeRect(NSMinX(rect), NSMinY(rect) + y, NSWidth(rect), textHeight);
}

- (NSRect)drawingRectForBounds:(NSRect)rect {
  return [self centeredTextRectForBounds:rect];
}

- (NSRect)titleRectForBounds:(NSRect)rect {
  return [self centeredTextRectForBounds:rect];
}

- (void)editWithFrame:(NSRect)rect
                inView:(NSView *)controlView
                editor:(NSText *)textObject
              delegate:(id)delegate
                 event:(NSEvent *)event {
  [super editWithFrame:[self centeredTextRectForBounds:rect]
                inView:controlView
                editor:textObject
              delegate:delegate
                 event:event];
}

- (void)selectWithFrame:(NSRect)rect
                  inView:(NSView *)controlView
                  editor:(NSText *)textObject
                delegate:(id)delegate
                   start:(NSInteger)selectionStart
                  length:(NSInteger)selectionLength {
  [super selectWithFrame:[self centeredTextRectForBounds:rect]
                  inView:controlView
                  editor:textObject
                delegate:delegate
                   start:selectionStart
                  length:selectionLength];
}

@end

@interface UFOChromeTabItem : NSView
@property(nonatomic, copy) NSString *targetID;
@property(nonatomic, strong) NSButton *selectButton;
@property(nonatomic, strong) UFOChromeHoverButton *closeButton;
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
  self.layer.cornerRadius = 11.0;

  _identityDot = [[NSView alloc] initWithFrame:NSZeroRect];
  _identityDot.wantsLayer = YES;
  _identityDot.layer.cornerRadius = 4.5;
  _identityDot.layer.backgroundColor = color(0.68).CGColor;
  [self addSubview:_identityDot];

  _selectButton = [NSButton buttonWithTitle:@"" target:target action:@selector(activateTab:)];
  _selectButton.bordered = NO;
  _selectButton.alignment = NSTextAlignmentLeft;
  _selectButton.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
  _selectButton.contentTintColor = color(0.18);
  _selectButton.lineBreakMode = NSLineBreakByTruncatingTail;
  _selectButton.focusRingType = NSFocusRingTypeNone;
  [self addSubview:_selectButton];

  _closeButton = [[UFOChromeHoverButton alloc]
      initWithSymbol:@"xmark"
           pointSize:10
              target:target
              action:@selector(closeTab:)];
  _closeButton.toolTip = @"关闭标签页";
  [self addSubview:_closeButton];
  return self;
}

- (BOOL)isFlipped { return YES; }

- (void)layout {
  [super layout];
  const CGFloat height = NSHeight(self.bounds);
  self.identityDot.frame = NSMakeRect(12, (height - 9) / 2.0, 9, 9);
  self.closeButton.frame = NSMakeRect(NSWidth(self.bounds) - 30, 4, 26, height - 8);
  self.selectButton.frame = NSMakeRect(27, 0, MAX(20, NSWidth(self.bounds) - 57), height);
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
  self.layer.backgroundColor = active ? color(0.925).CGColor : NSColor.clearColor.CGColor;
  self.layer.borderWidth = 0.0;
  self.identityDot.layer.backgroundColor = active
      ? color(0.62).CGColor
      : color(0.72).CGColor;
}

@end

@interface UFOBrowserChromeView : NSView <NSTextFieldDelegate, NSPopoverDelegate>
@property(nonatomic, copy) void (^eventSink)(NSDictionary *event);
@property(nonatomic, weak) NSWindow *parentWindow;
@property(nonatomic, strong) NSButton *backButton;
@property(nonatomic, strong) NSButton *forwardButton;
@property(nonatomic, strong) NSButton *reloadButton;
@property(nonatomic, strong) UFOChromeHoverButton *addTabButton;
@property(nonatomic, strong) UFOChromeRoundButton *spacesButton;
@property(nonatomic, strong) UFOChromeRoundButton *profileButton;
@property(nonatomic, strong) UFOChromeHoverButton *titlebarMenuButton;
@property(nonatomic, strong) NSView *addressBackdrop;
@property(nonatomic, strong) NSImageView *addressIcon;
@property(nonatomic, strong) NSTextField *addressField;
@property(nonatomic, strong) NSButton *addressClearButton;
@property(nonatomic, strong) NSView *separator;
@property(nonatomic, strong) NSMutableArray<UFOChromeTabItem *> *tabItems;
@property(nonatomic, strong) NSArray<NSDictionary *> *tabState;
@property(nonatomic, copy) NSString *activeTargetID;
@property(nonatomic, strong) NSPopover *tabSearchPopover;
@property(nonatomic, strong) UFOTabSearchViewController *tabSearchController;
@property(nonatomic) BOOL addressEditing;
@property(nonatomic, copy) NSString *pendingAddressValue;
@property(nonatomic, copy) NSString *pendingAddressTargetID;
@property(nonatomic, copy) NSString *pendingAddressInitialURL;
@property(nonatomic, copy) NSString *lastActiveURL;
@property(nonatomic) BOOL pendingAddressObservedLoading;
@property(nonatomic) BOOL controlled;
@property(nonatomic) NSInteger spaceCount;
- (void)updateState:(NSDictionary *)state;
- (NSData *)pngRepresentation;
- (NSDictionary *)inspection;
- (void)focusAddress;
- (void)alignAddressFieldEditor;
- (BOOL)handleMouseDownAtPoint:(NSPoint)point;
- (BOOL)handleWindowDragEvent:(NSEvent *)event atPoint:(NSPoint)point;
- (BOOL)isWindowDragPoint:(NSPoint)point;
- (void)activateTab:(NSButton *)sender;
- (void)closeTab:(NSButton *)sender;
- (void)clearAddress:(id)sender;
- (void)toggleTabSearch:(id)sender;
- (void)showProfileMenu:(id)sender;
- (void)submitAddressForTesting:(NSString *)value;
@end

@implementation UFOBrowserChromeView

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (!self) return nil;
  self.wantsLayer = YES;
  self.layer.backgroundColor = NSColor.whiteColor.CGColor;
  _tabItems = [[NSMutableArray alloc] init];
  _tabState = @[];
  _spaceCount = 1;

  _titlebarMenuButton = [[UFOChromeHoverButton alloc]
      initWithSymbol:@"chevron.down"
           pointSize:13
              target:self
              action:@selector(toggleTabSearch:)];
  _titlebarMenuButton.toolTip = @"搜索标签页";
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

  _addTabButton = [[UFOChromeHoverButton alloc]
      initWithSymbol:@"plus"
           pointSize:14
              target:self
              action:@selector(newTab:)];
  _addTabButton.toolTip = @"新建标签页";
  [self addSubview:_addTabButton];

  _spacesButton = [[UFOChromeRoundButton alloc]
      initWithSymbol:@"square.grid.2x2.fill"
           pointSize:14
              target:self
              action:@selector(showOverview:)];
  _spacesButton.toolTip = @"返回 Spaces";
  [self addSubview:_spacesButton];

  _profileButton = [[UFOChromeRoundButton alloc]
      initWithSymbol:@"person.crop.circle"
           pointSize:18
              target:self
              action:@selector(showProfileMenu:)];
  _profileButton.toolTip = @"浏览器菜单";
  [self addSubview:_profileButton];

  _addressBackdrop = [[NSView alloc] initWithFrame:NSZeroRect];
  _addressBackdrop.wantsLayer = YES;
  _addressBackdrop.layer.backgroundColor = color(0.969).CGColor;
  _addressBackdrop.layer.cornerCurve = kCACornerCurveContinuous;
  _addressBackdrop.layer.cornerRadius = 16.0;
  _addressBackdrop.layer.borderWidth = 0.5;
  _addressBackdrop.layer.borderColor = color(0.84, 0.30).CGColor;
  [self addSubview:_addressBackdrop];

  _addressIcon = [[NSImageView alloc] initWithFrame:NSZeroRect];
  _addressIcon.image = symbol(@"magnifyingglass", 14, NSFontWeightRegular);
  _addressIcon.imageScaling = NSImageScaleProportionallyDown;
  _addressIcon.contentTintColor = color(0.43);
  [self addSubview:_addressIcon];

  _addressField = [[NSTextField alloc] initWithFrame:NSZeroRect];
  UFOChromeAddressFieldCell *addressCell =
      [[UFOChromeAddressFieldCell alloc] initTextCell:@""];
  addressCell.usesSingleLineMode = YES;
  addressCell.scrollable = YES;
  addressCell.wraps = NO;
  addressCell.lineBreakMode = NSLineBreakByClipping;
  _addressField.cell = addressCell;
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

  _addressClearButton = [self symbolButton:@"xmark.circle.fill"
                                    action:@selector(clearAddress:)];
  _addressClearButton.contentTintColor = color(0.38, 0.86);
  _addressClearButton.toolTip = @"清除地址";
  _addressClearButton.hidden = YES;
  [self addSubview:_addressClearButton];

  _separator = [[NSView alloc] initWithFrame:NSZeroRect];
  _separator.wantsLayer = YES;
  _separator.layer.backgroundColor = color(0.87, 0.82).CGColor;
  [self addSubview:_separator];
  return self;
}

- (BOOL)isFlipped { return YES; }
- (BOOL)mouseDownCanMoveWindow { return NO; }

- (void)mouseDown:(NSEvent *)event {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  if ([self handleMouseDownAtPoint:point]) return;
  if ([self handleWindowDragEvent:event atPoint:point]) return;
  [super mouseDown:event];
}

- (BOOL)handleWindowDragEvent:(NSEvent *)event atPoint:(NSPoint)point {
  if (![self isWindowDragPoint:point] || !self.parentWindow) return NO;
  [self.parentWindow performWindowDragWithEvent:event];
  return YES;
}

- (BOOL)isWindowDragPoint:(NSPoint)point {
  return !self.hidden &&
      NSPointInRect(point, self.bounds) &&
      point.y >= 0 && point.y < kTitlebarHeight;
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
    if (!self.addTabButton.enabled) return NO;
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
  if (!self.addressClearButton.hidden &&
      NSPointInRect(point, self.addressClearButton.frame)) {
    [self.addressClearButton performClick:nil];
    return YES;
  }
  if (NSPointInRect(point, self.addressBackdrop.frame)) {
    [self focusAddress];
    return YES;
  }

  for (UFOChromeTabItem *item in self.tabItems) {
    if (!NSPointInRect(point, item.frame)) continue;
    // Agent-owned tabs are intentionally non-interactive. Route their first
    // row through the window drag path instead of letting disabled NSButtons
    // swallow the mouseDown before the chrome view can see it.
    if (self.controlled) return NO;
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
  button.contentTintColor = color(0.30, 0.90);
  button.focusRingType = NSFocusRingTypeNone;
  return button;
}

- (void)layout {
  [super layout];
  const CGFloat width = NSWidth(self.bounds);
  // Chromium's tab-search control uses the same visual scale as a normal tab
  // affordance: a compact 28pt circle whose centre sits immediately after the
  // traffic lights.  Keeping the former 34pt hit box made it read as a pasted
  // toolbar button instead of part of the native titlebar.
  self.titlebarMenuButton.frame = NSMakeRect(82, 16, 28, 28);
  self.spacesButton.frame = NSMakeRect(width - 42, 13, 34, 34);

  const CGFloat tabsLeft = 112;
  const CGFloat tabsRight = width - 58;
  const CGFloat tabsWidth = MAX(80, tabsRight - tabsLeft - 35);
  const NSUInteger count = self.tabItems.count;
  const CGFloat itemWidth = count > 0
      ? MIN(232.0, MAX(116.0, (tabsWidth - MAX(0, (NSInteger)count - 1) * 3.0) / count))
      : 0;
  CGFloat tabX = tabsLeft;
  for (UFOChromeTabItem *item in self.tabItems) {
    item.frame = NSMakeRect(tabX, 12, itemWidth, 32);
    tabX += itemWidth + 3;
  }
  self.addTabButton.frame = NSMakeRect(MIN(tabX + 2, tabsRight), 14, 28, 28);

  const CGFloat toolbarY = 54;
  self.backButton.frame = NSMakeRect(0, toolbarY + 3, 30, 30);
  self.forwardButton.frame = NSMakeRect(36, toolbarY + 3, 30, 30);
  self.reloadButton.frame = NSMakeRect(72, toolbarY + 3, 30, 30);
  self.profileButton.frame = NSMakeRect(width - 42, toolbarY + 1, 34, 34);
  self.addressBackdrop.frame = NSMakeRect(
      110,
      toolbarY + 2,
      MAX(120, width - 110 - 54),
      32);
  const CGFloat addressLeft = NSMinX(self.addressBackdrop.frame);
  const CGFloat addressRight = NSMaxX(self.addressBackdrop.frame);
  self.addressIcon.frame = NSMakeRect(addressLeft + 10, toolbarY + 9, 18, 18);
  self.addressClearButton.frame = NSMakeRect(addressRight - 30, toolbarY + 5, 26, 26);
  self.addressField.frame = NSMakeRect(
      addressLeft + 36,
      toolbarY + 4,
      MAX(72, addressRight - addressLeft - 70),
      28);
  self.separator.frame = NSMakeRect(0, kChromeHeight - 1, width, 1);
}

- (void)updateState:(NSDictionary *)state {
  NSDictionary *space = [state[@"space"] isKindOfClass:NSDictionary.class]
      ? state[@"space"]
      : @{};
  NSArray *tabs = [space[@"tabs"] isKindOfClass:NSArray.class] ? space[@"tabs"] : @[];
  NSString *activeTarget = safeString(space[@"activeTabId"]);
  self.tabState = [tabs copy];
  self.activeTargetID = activeTarget;
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
  if (self.tabSearchPopover.isShown) {
    [self.tabSearchController updateTabs:self.tabState activeTargetID:activeTarget];
  }

  self.spaceCount = MAX(1, safeInteger(state[@"spaceCount"], 1));
  self.backButton.enabled = !self.controlled && safeBool(state[@"canGoBack"]);
  self.forwardButton.enabled = !self.controlled && safeBool(state[@"canGoForward"]);
  self.reloadButton.enabled = !self.controlled;
  self.addTabButton.enabled = !self.controlled;
  self.addressField.editable = !self.controlled;
  self.addressField.selectable = !self.controlled;
  self.addressClearButton.enabled = !self.controlled;
  self.addressBackdrop.layer.backgroundColor = self.controlled
      ? [NSColor colorWithRed:0.94 green:0.95 blue:0.98 alpha:1.0].CGColor
      : color(0.969).CGColor;
  if (!self.addressEditing) {
    self.addressBackdrop.layer.borderWidth = 0.5;
    self.addressBackdrop.layer.borderColor = color(0.84, 0.30).CGColor;
  }
  self.layer.borderWidth = self.controlled ? 1.0 : 0.0;
  self.layer.borderColor = self.controlled
      ? [NSColor colorWithRed:0.39 green:0.55 blue:0.94 alpha:0.42].CGColor
      : NSColor.clearColor.CGColor;

  NSDictionary *activeTab = [state[@"activeTab"] isKindOfClass:NSDictionary.class]
      ? state[@"activeTab"]
      : @{};
  NSString *url = safeString(activeTab[@"url"]);
  self.lastActiveURL = url;
  const BOOL loading = safeBool(state[@"loading"]);
  const BOOL pendingTargetExists = self.pendingAddressTargetID.length > 0 &&
      [tabs indexOfObjectPassingTest:^BOOL(id value, NSUInteger index, BOOL *stop) {
        NSDictionary *tab = [value isKindOfClass:NSDictionary.class] ? value : @{};
        return [safeString(tab[@"targetId"]) isEqualToString:self.pendingAddressTargetID];
      }] != NSNotFound;
  if (self.pendingAddressTargetID.length > 0 && !pendingTargetExists) {
    self.pendingAddressValue = nil;
    self.pendingAddressTargetID = nil;
    self.pendingAddressInitialURL = nil;
    self.pendingAddressObservedLoading = NO;
  }
  BOOL pendingForActiveTab = self.pendingAddressValue.length > 0 &&
      [self.pendingAddressTargetID isEqualToString:activeTarget];
  if (pendingForActiveTab && loading) {
    self.pendingAddressObservedLoading = YES;
  }
  if (pendingForActiveTab && !loading &&
      (self.pendingAddressObservedLoading ||
       ![url isEqualToString:self.pendingAddressInitialURL ?: @""])) {
    self.pendingAddressValue = nil;
    self.pendingAddressTargetID = nil;
    self.pendingAddressInitialURL = nil;
    self.pendingAddressObservedLoading = NO;
    pendingForActiveTab = NO;
  }

  if (!self.addressEditing) {
    if (pendingForActiveTab) {
      self.addressField.stringValue = self.pendingAddressValue;
    } else if ([url isEqualToString:@"https://www.google.com/"] ||
               [url isEqualToString:@"https://google.com/"]) {
      self.addressField.stringValue = @"";
    } else {
      self.addressField.stringValue = url;
    }
    self.addressClearButton.hidden = self.addressField.stringValue.length == 0;
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
  UFOChromeTabItem *firstTab = self.tabItems.firstObject;
  NSPoint firstTabPoint = firstTab
      ? NSMakePoint(NSMidX(firstTab.frame), NSMidY(firstTab.frame))
      : NSZeroPoint;
  return @{
    @"visible": @(!self.hidden && self.window.isVisible),
    @"titlebarDraggable": @([self isWindowDragPoint:NSMakePoint(
        MAX(112.0, NSWidth(self.bounds) * 0.72), 6.0)]),
    @"controlled": @(self.controlled),
    @"controlledTabDraggable": @(
        self.controlled && firstTab && !firstTab.selectButton.enabled &&
        [self isWindowDragPoint:firstTabPoint]),
    @"tabCount": @(self.tabItems.count),
    @"spacesCount": [NSString stringWithFormat:@"%ld", (long)self.spaceCount],
    @"addressValue": self.addressField.stringValue ?: @"",
    @"addressPending": @(self.pendingAddressValue.length > 0 &&
        [self.pendingAddressTargetID isEqualToString:self.activeTargetID]),
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
  [self alignAddressFieldEditor];
  [self.addressField selectText:nil];
}

- (void)alignAddressFieldEditor {
  NSText *currentEditor = self.addressField.currentEditor;
  if (![currentEditor isKindOfClass:NSTextView.class]) return;
  NSTextView *fieldEditor = (NSTextView *)currentEditor;
  fieldEditor.textContainerInset = NSMakeSize(0, 0);
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
- (void)toggleTabSearch:(id)sender {
  if (self.tabSearchPopover.isShown) {
    [self.tabSearchPopover close];
    return;
  }

  UFOTabSearchViewController *controller =
      [[UFOTabSearchViewController alloc] init];
  __weak UFOBrowserChromeView *weakSelf = self;
  controller.activateTarget = ^(NSString *targetID) {
    UFOBrowserChromeView *strongSelf = weakSelf;
    if (!strongSelf) return;
    [strongSelf emit:@"activate-tab" extra:@{ @"targetId": targetID ?: @"" }];
    [strongSelf.tabSearchPopover close];
  };
  controller.closeTarget = ^(NSString *targetID) {
    UFOBrowserChromeView *strongSelf = weakSelf;
    if (!strongSelf) return;
    [strongSelf emit:@"close-tab" extra:@{ @"targetId": targetID ?: @"" }];
  };
  [controller updateTabs:self.tabState activeTargetID:self.activeTargetID ?: @""];

  NSPopover *popover = [[NSPopover alloc] init];
  popover.behavior = NSPopoverBehaviorTransient;
  popover.animates = YES;
  popover.contentSize = NSMakeSize(360, 420);
  popover.contentViewController = controller;
  popover.delegate = self;
  self.tabSearchController = controller;
  self.tabSearchPopover = popover;
  self.titlebarMenuButton.state = NSControlStateValueOn;
  [self.titlebarMenuButton refreshAppearance];
  [popover showRelativeToRect:self.titlebarMenuButton.bounds
                       ofView:self.titlebarMenuButton
                preferredEdge:NSRectEdgeMaxY];
  [controller.searchField.window makeFirstResponder:controller.searchField];
}

- (void)popoverWillClose:(NSNotification *)notification {
  self.titlebarMenuButton.state = NSControlStateValueOff;
  [self.titlebarMenuButton refreshAppearance];
}
- (void)clearAddress:(id)sender {
  if (!self.addressField.editable) return;
  self.pendingAddressValue = nil;
  self.pendingAddressTargetID = nil;
  self.pendingAddressInitialURL = nil;
  self.pendingAddressObservedLoading = NO;
  self.addressField.stringValue = @"";
  self.addressClearButton.hidden = YES;
  [self focusAddress];
}
- (void)showProfileMenu:(id)sender {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
  menu.autoenablesItems = NO;

  NSMenuItem *profileItem = [[NSMenuItem alloc]
      initWithTitle:@"您的 UFO-Browser"
             action:nil
      keyEquivalent:@""];
  profileItem.image = symbol(@"person.crop.circle", 16, NSFontWeightMedium);
  profileItem.enabled = NO;
  [menu addItem:profileItem];
  [menu addItem:NSMenuItem.separatorItem];

  NSMenuItem *newTabItem = [[NSMenuItem alloc]
      initWithTitle:@"打开新的标签页"
             action:@selector(newTab:)
      keyEquivalent:@"t"];
  newTabItem.target = self;
  newTabItem.image = symbol(@"plus.square", 14, NSFontWeightRegular);
  newTabItem.enabled = !self.controlled;
  [menu addItem:newTabItem];

  NSMenuItem *reloadItem = [[NSMenuItem alloc]
      initWithTitle:@"重新加载当前页面"
             action:@selector(reload:)
      keyEquivalent:@"r"];
  reloadItem.target = self;
  reloadItem.image = symbol(@"arrow.clockwise", 14, NSFontWeightRegular);
  reloadItem.enabled = !self.controlled;
  [menu addItem:reloadItem];
  [menu addItem:NSMenuItem.separatorItem];

  NSMenuItem *overviewItem = [[NSMenuItem alloc]
      initWithTitle:@"返回 Spaces"
             action:@selector(showOverview:)
      keyEquivalent:@""];
  overviewItem.target = self;
  overviewItem.image = symbol(@"square.grid.2x2", 14, NSFontWeightRegular);
  overviewItem.enabled = YES;
  [menu addItem:overviewItem];

  NSPoint anchor = NSMakePoint(NSMaxX(self.profileButton.frame) - 4,
                               NSMaxY(self.profileButton.frame) + 2);
  [menu popUpMenuPositioningItem:nil atLocation:anchor inView:self];
}
- (void)submitAddress:(id)sender {
  NSString *value = [self.addressField.stringValue
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (value.length == 0) return;
  self.pendingAddressValue = value;
  self.pendingAddressTargetID = self.activeTargetID ?: @"";
  self.pendingAddressInitialURL = self.lastActiveURL ?: @"";
  self.pendingAddressObservedLoading = NO;
  [self.window makeFirstResponder:nil];
  self.addressEditing = NO;
  [self emit:@"navigate" extra:@{ @"value": value }];
}

- (void)submitAddressForTesting:(NSString *)value {
  if (!self.addressField.editable || value.length == 0) return;
  self.addressField.stringValue = value;
  [self submitAddress:nil];
}

- (void)controlTextDidBeginEditing:(NSNotification *)notification {
  if ([self.pendingAddressTargetID isEqualToString:self.activeTargetID]) {
    self.pendingAddressValue = nil;
    self.pendingAddressTargetID = nil;
    self.pendingAddressInitialURL = nil;
    self.pendingAddressObservedLoading = NO;
  }
  self.addressEditing = YES;
  [self alignAddressFieldEditor];
  self.addressClearButton.hidden = self.addressField.stringValue.length == 0;
  self.addressBackdrop.layer.borderWidth = 1.5;
  self.addressBackdrop.layer.borderColor =
      [NSColor colorWithRed:0.10 green:0.43 blue:0.91 alpha:0.92].CGColor;
}
- (void)controlTextDidEndEditing:(NSNotification *)notification {
  self.addressEditing = NO;
  self.addressClearButton.hidden = self.addressField.stringValue.length == 0;
  self.addressBackdrop.layer.borderWidth = 0.5;
  self.addressBackdrop.layer.borderColor = color(0.84, 0.30).CGColor;
}

- (void)controlTextDidChange:(NSNotification *)notification {
  self.addressClearButton.hidden = self.addressField.stringValue.length == 0;
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
        if ([chrome handleMouseDownAtPoint:point]) return nil;
        // Run window dragging at the local-monitor level so disabled child
        // controls cannot intercept Agent-controlled titlebar drags.
        return [chrome handleWindowDragEvent:event atPoint:point] ? nil : event;
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

napi_value submitChromeAddressForTest(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string value;
  if (argc < 1 || !readString(env, argv[0], &value) || value.empty() ||
      !chromeBridge.chromeView) {
    return booleanValue(env, false);
  }
  [chromeBridge.chromeView submitAddressForTesting:
      [NSString stringWithUTF8String:value.c_str()]];
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
      {"submitChromeAddressForTest", nullptr, submitChromeAddressForTest,
       nullptr, nullptr, nullptr, napi_default, nullptr},
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
