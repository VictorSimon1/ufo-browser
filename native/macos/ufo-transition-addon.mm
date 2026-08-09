#include <node_api.h>

#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>
#import <QuartzCore/QuartzCore.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>

@interface UFOSnapshotRecord : NSObject
@property(nonatomic, readonly) CGImageRef image;
@property(nonatomic, readonly) CGFloat scale;
- (instancetype)initWithImage:(CGImageRef)image scale:(CGFloat)scale;
@end

@implementation UFOSnapshotRecord {
  CGImageRef _image;
  CGFloat _scale;
}

- (instancetype)initWithImage:(CGImageRef)image scale:(CGFloat)scale {
  self = [super init];
  if (self) {
    _image = CGImageRetain(image);
    _scale = scale;
  }
  return self;
}

- (void)dealloc {
  if (_image) CGImageRelease(_image);
}

- (CGImageRef)image { return _image; }
- (CGFloat)scale { return _scale; }

@end

@interface UFOTransitionBlockerView : NSView
@end

@implementation UFOTransitionBlockerView
- (BOOL)isFlipped { return YES; }
- (NSView *)hitTest:(NSPoint)point { return self; }
- (void)mouseDown:(NSEvent *)event {}
- (void)mouseUp:(NSEvent *)event {}
- (void)rightMouseDown:(NSEvent *)event {}
- (void)rightMouseUp:(NSEvent *)event {}
- (void)otherMouseDown:(NSEvent *)event {}
- (void)otherMouseUp:(NSEvent *)event {}
- (void)scrollWheel:(NSEvent *)event {}
@end

@interface UFOActiveTransition : NSObject
@property(nonatomic, strong) NSString *token;
@property(nonatomic, strong) NSPanel *panel;
@property(nonatomic, strong) NSWindow *parentWindow;
@property(nonatomic, strong) CALayer *snapshotLayer;
@property(nonatomic) CFTimeInterval duration;
@end

@implementation UFOActiveTransition
@end

NSMutableDictionary<NSString *, UFOSnapshotRecord *> *snapshotCache;
NSMutableArray<NSString *> *snapshotLRU;
UFOActiveTransition *activeTransition;

constexpr NSUInteger kMaximumCachedSnapshots = 6;

void ensureState() {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    snapshotCache = [[NSMutableDictionary alloc] init];
    snapshotLRU = [[NSMutableArray alloc] init];
  });
}

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

bool readDouble(napi_env env, napi_value value, double *result) {
  return napi_get_value_double(env, value, result) == napi_ok &&
         std::isfinite(*result);
}

bool readNamedDouble(
    napi_env env,
    napi_value object,
    const char *name,
    double *result) {
  napi_value value;
  return napi_get_named_property(env, object, name, &value) == napi_ok &&
         readDouble(env, value, result);
}

napi_value booleanValue(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

CGImageRef decodeImage(const void *bytes, size_t length) {
  if (!bytes || length == 0) return nullptr;
  CFDataRef data = CFDataCreate(
      kCFAllocatorDefault,
      static_cast<const UInt8 *>(bytes),
      static_cast<CFIndex>(length));
  if (!data) return nullptr;
  CGImageSourceRef source = CGImageSourceCreateWithData(data, nullptr);
  CFRelease(data);
  if (!source) return nullptr;
  CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, nullptr);
  CFRelease(source);
  return image;
}

CGImageRef combinedImage(CGImageRef chrome, CGImageRef page) {
  if (!chrome || !page) return nullptr;
  const size_t chromeWidth = CGImageGetWidth(chrome);
  const size_t chromeHeight = CGImageGetHeight(chrome);
  const size_t pageWidth = CGImageGetWidth(page);
  const size_t pageHeight = CGImageGetHeight(page);
  const size_t width = std::max(chromeWidth, pageWidth);
  const size_t height = chromeHeight + pageHeight;
  if (width == 0 || height == 0) return nullptr;

  CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef context = CGBitmapContextCreate(
      nullptr,
      width,
      height,
      8,
      width * 4,
      colorSpace,
      kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(colorSpace);
  if (!context) return nullptr;

  CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
  CGContextSetRGBFillColor(context, 0.972, 0.980, 0.976, 1.0);
  CGContextFillRect(context, CGRectMake(0, 0, width, height));
  CGContextDrawImage(
      context,
      CGRectMake(0, 0, width, pageHeight),
      page);
  CGContextDrawImage(
      context,
      CGRectMake(0, pageHeight, width, chromeHeight),
      chrome);
  CGImageRef result = CGBitmapContextCreateImage(context);
  CGContextRelease(context);
  return result;
}

void rememberSnapshot(NSString *key, UFOSnapshotRecord *record) {
  ensureState();
  snapshotCache[key] = record;
  [snapshotLRU removeObject:key];
  [snapshotLRU addObject:key];
  while (snapshotLRU.count > kMaximumCachedSnapshots) {
    NSString *oldest = snapshotLRU.firstObject;
    if (!oldest) break;
    [snapshotLRU removeObjectAtIndex:0];
    [snapshotCache removeObjectForKey:oldest];
  }
}

void touchSnapshot(NSString *key) {
  [snapshotLRU removeObject:key];
  [snapshotLRU addObject:key];
}

void removeActiveTransition() {
  if (!activeTransition) return;
  [activeTransition.snapshotLayer removeAllAnimations];
  if (activeTransition.parentWindow && activeTransition.panel) {
    [activeTransition.parentWindow removeChildWindow:activeTransition.panel];
  }
  [activeTransition.panel orderOut:nil];
  activeTransition = nil;
}

void configureSpring(CASpringAnimation *animation, bool exitsToOverview) {
  // Both directions use a near-critical native spring. Expansion is only a
  // little quicker than contraction; a hard, overdamped expansion moves too
  // much of the full browser surface in its first two frames and reads as a
  // jump instead of a continuous window zoom.
  animation.mass = 1.0;
  animation.stiffness = exitsToOverview ? 210.0 : 250.0;
  animation.damping = exitsToOverview ? 28.0 : 30.0;
  animation.initialVelocity = 0.0;
  animation.fillMode = kCAFillModeBoth;
  animation.removedOnCompletion = NO;
}

napi_value cacheSnapshot(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 4) {
    throwError(env, "cacheSnapshot requires key, chrome PNG, page PNG and logical width");
    return nullptr;
  }

  std::string keyValue;
  if (!readString(env, argv[0], &keyValue) || keyValue.empty()) {
    throwError(env, "cacheSnapshot key must be a non-empty string");
    return nullptr;
  }
  void *chromeBytes = nullptr;
  size_t chromeLength = 0;
  void *pageBytes = nullptr;
  size_t pageLength = 0;
  double logicalWidth = 0;
  if (napi_get_buffer_info(env, argv[1], &chromeBytes, &chromeLength) != napi_ok ||
      napi_get_buffer_info(env, argv[2], &pageBytes, &pageLength) != napi_ok ||
      !readDouble(env, argv[3], &logicalWidth) || logicalWidth <= 0) {
    throwError(env, "cacheSnapshot received invalid image data");
    return nullptr;
  }

  CGImageRef chrome = decodeImage(chromeBytes, chromeLength);
  CGImageRef page = decodeImage(pageBytes, pageLength);
  CGImageRef combined = combinedImage(chrome, page);
  if (chrome) CGImageRelease(chrome);
  if (page) CGImageRelease(page);
  if (!combined) return booleanValue(env, false);

  const CGFloat scale = std::max<CGFloat>(
      1.0,
      static_cast<CGFloat>(CGImageGetWidth(combined) / logicalWidth));
  NSString *key = [NSString stringWithUTF8String:keyValue.c_str()];
  UFOSnapshotRecord *record =
      [[UFOSnapshotRecord alloc] initWithImage:combined scale:scale];
  CGImageRelease(combined);
  rememberSnapshot(key, record);
  return booleanValue(env, true);
}

napi_value hasSnapshot(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string keyValue;
  if (argc < 1 || !readString(env, argv[0], &keyValue)) {
    return booleanValue(env, false);
  }
  ensureState();
  NSString *key = [NSString stringWithUTF8String:keyValue.c_str()];
  return booleanValue(env, snapshotCache[key] != nil);
}

napi_value beginTransition(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 3) {
    throwError(env, "beginTransition requires a native window handle, key and options");
    return nullptr;
  }

  void *handleBytes = nullptr;
  size_t handleLength = 0;
  std::string keyValue;
  if (napi_get_buffer_info(env, argv[0], &handleBytes, &handleLength) != napi_ok ||
      handleLength < sizeof(void *) ||
      !readString(env, argv[1], &keyValue) || keyValue.empty()) {
    throwError(env, "beginTransition received an invalid window handle or key");
    return nullptr;
  }

  double sourceX = 0;
  double sourceY = 0;
  double sourceWidth = 0;
  double sourceHeight = 0;
  std::string tokenValue;
  std::string directionValue;
  napi_value token;
  if (!readNamedDouble(env, argv[2], "x", &sourceX) ||
      !readNamedDouble(env, argv[2], "y", &sourceY) ||
      !readNamedDouble(env, argv[2], "width", &sourceWidth) ||
      !readNamedDouble(env, argv[2], "height", &sourceHeight) ||
      napi_get_named_property(env, argv[2], "token", &token) != napi_ok ||
      !readString(env, token, &tokenValue) || tokenValue.empty()) {
    throwError(env, "beginTransition options are invalid");
    return nullptr;
  }

  napi_value direction;
  if (napi_get_named_property(env, argv[2], "direction", &direction) == napi_ok) {
    readString(env, direction, &directionValue);
  }
  const bool exitsToOverview = directionValue == "exit";

  ensureState();
  NSString *key = [NSString stringWithUTF8String:keyValue.c_str()];
  UFOSnapshotRecord *snapshot = snapshotCache[key];
  if (!snapshot) {
    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "started", booleanValue(env, false));
    return result;
  }

  uintptr_t nativePointer = 0;
  std::memcpy(&nativePointer, handleBytes, sizeof(nativePointer));
  NSView *nativeView = (__bridge NSView *)reinterpret_cast<void *>(nativePointer);
  NSWindow *parentWindow = nativeView.window;
  if (!nativeView || !parentWindow || sourceWidth < 32 || sourceHeight < 32) {
    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "started", booleanValue(env, false));
    return result;
  }

  removeActiveTransition();
  touchSnapshot(key);

  NSRect windowRect = [nativeView convertRect:nativeView.bounds toView:nil];
  NSRect screenRect = [parentWindow convertRectToScreen:windowRect];
  const CGFloat destinationWidth = NSWidth(nativeView.bounds);
  const CGFloat destinationHeight = NSHeight(nativeView.bounds);
  sourceX = std::clamp(sourceX, 0.0, std::max(0.0, destinationWidth - 1.0));
  sourceY = std::clamp(sourceY, 0.0, std::max(0.0, destinationHeight - 1.0));
  sourceWidth = std::min(sourceWidth, destinationWidth - sourceX);
  sourceHeight = std::min(sourceHeight, destinationHeight - sourceY);

  NSPanel *panel = [[NSPanel alloc]
      initWithContentRect:screenRect
                styleMask:NSWindowStyleMaskBorderless |
                          NSWindowStyleMaskNonactivatingPanel
                  backing:NSBackingStoreBuffered
                    defer:NO];
  panel.opaque = NO;
  panel.backgroundColor = NSColor.clearColor;
  panel.hasShadow = NO;
  panel.hidesOnDeactivate = NO;
  panel.ignoresMouseEvents = NO;
  panel.acceptsMouseMovedEvents = YES;
  panel.releasedWhenClosed = NO;
  panel.collectionBehavior = NSWindowCollectionBehaviorTransient |
                             NSWindowCollectionBehaviorIgnoresCycle |
                             NSWindowCollectionBehaviorFullScreenAuxiliary;
  panel.level = parentWindow.level;

  UFOTransitionBlockerView *root = [[UFOTransitionBlockerView alloc]
      initWithFrame:NSMakeRect(0, 0, destinationWidth, destinationHeight)];
  root.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  root.wantsLayer = YES;
  root.layer.geometryFlipped = YES;
  root.layer.backgroundColor = NSColor.clearColor.CGColor;
  panel.contentView = root;

  CALayer *shade = [CALayer layer];
  shade.frame = root.bounds;
  shade.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
  shade.backgroundColor = [NSColor colorWithWhite:0.94 alpha:0.20].CGColor;
  shade.opacity = 0;
  [root.layer addSublayer:shade];

  CALayer *surface = [CALayer layer];
  surface.contents = (__bridge id)snapshot.image;
  surface.contentsScale = snapshot.scale;
  surface.contentsGravity = kCAGravityResize;
  surface.minificationFilter = kCAFilterLinear;
  surface.magnificationFilter = kCAFilterLinear;
  surface.masksToBounds = YES;
  surface.cornerCurve = kCACornerCurveContinuous;
  surface.cornerRadius = exitsToOverview ? 0.0 : 18.0;
  surface.borderWidth = exitsToOverview ? 0.0 : 1.0;
  surface.borderColor = [NSColor colorWithWhite:0.18 alpha:0.14].CGColor;
  surface.shadowColor = NSColor.blackColor.CGColor;
  surface.shadowOpacity = exitsToOverview ? 0.0 : 0.13;
  surface.shadowRadius = 22.0;
  surface.shadowOffset = CGSizeMake(0, 12);
  const CGRect fullBounds = CGRectMake(
      0, 0, destinationWidth, destinationHeight);
  const CGRect cardBounds = CGRectMake(0, 0, sourceWidth, sourceHeight);
  const CGPoint fullPosition = CGPointMake(
      destinationWidth / 2.0,
      destinationHeight / 2.0);
  const CGPoint cardPosition = CGPointMake(
      sourceX + sourceWidth / 2.0,
      sourceY + sourceHeight / 2.0);
  surface.bounds = exitsToOverview ? fullBounds : cardBounds;
  surface.position = exitsToOverview ? fullPosition : cardPosition;
  [root.layer addSublayer:surface];

  [parentWindow addChildWindow:panel ordered:NSWindowAbove];
  [panel orderFront:nil];

  CASpringAnimation *boundsAnimation =
      [CASpringAnimation animationWithKeyPath:@"bounds"];
  configureSpring(boundsAnimation, exitsToOverview);
  boundsAnimation.fromValue = [NSValue valueWithRect:
      exitsToOverview ? fullBounds : cardBounds];
  boundsAnimation.toValue = [NSValue valueWithRect:
      exitsToOverview ? cardBounds : fullBounds];

  CASpringAnimation *positionAnimation =
      [CASpringAnimation animationWithKeyPath:@"position"];
  configureSpring(positionAnimation, exitsToOverview);
  positionAnimation.fromValue = [NSValue valueWithPoint:
      exitsToOverview ? fullPosition : cardPosition];
  positionAnimation.toValue = [NSValue valueWithPoint:
      exitsToOverview ? cardPosition : fullPosition];

  const CFTimeInterval duration = exitsToOverview
      ? std::max(0.34, std::min(0.48, boundsAnimation.settlingDuration))
      : std::max(0.32, std::min(0.46, boundsAnimation.settlingDuration));
  boundsAnimation.duration = duration;
  positionAnimation.duration = duration;

  CABasicAnimation *cornerAnimation =
      [CABasicAnimation animationWithKeyPath:@"cornerRadius"];
  cornerAnimation.fromValue = exitsToOverview ? @0.0 : @18.0;
  cornerAnimation.toValue = exitsToOverview ? @18.0 : @0.0;
  cornerAnimation.duration = duration * 0.9;
  cornerAnimation.timingFunction = [CAMediaTimingFunction
      functionWithControlPoints:0.22 :0.78 :0.18 :1.0];
  cornerAnimation.fillMode = kCAFillModeBoth;
  cornerAnimation.removedOnCompletion = NO;

  CABasicAnimation *borderAnimation =
      [CABasicAnimation animationWithKeyPath:@"borderWidth"];
  borderAnimation.fromValue = exitsToOverview ? @0.0 : @1.0;
  borderAnimation.toValue = exitsToOverview ? @1.0 : @0.0;
  borderAnimation.duration = duration * 0.7;
  borderAnimation.timingFunction = cornerAnimation.timingFunction;
  borderAnimation.fillMode = kCAFillModeBoth;
  borderAnimation.removedOnCompletion = NO;

  CABasicAnimation *shadowAnimation =
      [CABasicAnimation animationWithKeyPath:@"shadowOpacity"];
  shadowAnimation.fromValue = exitsToOverview ? @0.0 : @0.13;
  shadowAnimation.toValue = exitsToOverview ? @0.13 : @0.0;
  shadowAnimation.duration = duration * 0.78;
  shadowAnimation.timingFunction = cornerAnimation.timingFunction;
  shadowAnimation.fillMode = kCAFillModeBoth;
  shadowAnimation.removedOnCompletion = NO;

  CABasicAnimation *shadeAnimation =
      [CABasicAnimation animationWithKeyPath:@"opacity"];
  shadeAnimation.fromValue = @0.0;
  shadeAnimation.toValue = exitsToOverview ? @0.0 : @1.0;
  shadeAnimation.duration = duration * 0.72;
  shadeAnimation.timingFunction = cornerAnimation.timingFunction;
  shadeAnimation.fillMode = kCAFillModeBoth;
  shadeAnimation.removedOnCompletion = NO;

  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  surface.bounds = exitsToOverview ? cardBounds : fullBounds;
  surface.position = exitsToOverview ? cardPosition : fullPosition;
  surface.cornerRadius = exitsToOverview ? 18.0 : 0.0;
  surface.borderWidth = exitsToOverview ? 1.0 : 0.0;
  surface.shadowOpacity = exitsToOverview ? 0.13 : 0.0;
  shade.opacity = exitsToOverview ? 0.0 : 1.0;
  [surface addAnimation:boundsAnimation forKey:@"ufo.bounds"];
  [surface addAnimation:positionAnimation forKey:@"ufo.position"];
  [surface addAnimation:cornerAnimation forKey:@"ufo.corner"];
  [surface addAnimation:borderAnimation forKey:@"ufo.border"];
  [surface addAnimation:shadowAnimation forKey:@"ufo.shadow"];
  [shade addAnimation:shadeAnimation forKey:@"ufo.shade"];
  [CATransaction commit];

  activeTransition = [[UFOActiveTransition alloc] init];
  activeTransition.token = [NSString stringWithUTF8String:tokenValue.c_str()];
  activeTransition.panel = panel;
  activeTransition.parentWindow = parentWindow;
  activeTransition.snapshotLayer = surface;
  activeTransition.duration = duration;

  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "started", booleanValue(env, true));
  napi_value durationValue;
  napi_create_double(env, std::ceil(duration * 1000.0), &durationValue);
  napi_set_named_property(env, result, "durationMs", durationValue);
  return result;
}

napi_value finishTransition(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string tokenValue;
  if (argc < 1 || !readString(env, argv[0], &tokenValue) || !activeTransition) {
    return booleanValue(env, false);
  }
  NSString *token = [NSString stringWithUTF8String:tokenValue.c_str()];
  if (![activeTransition.token isEqualToString:token]) {
    return booleanValue(env, false);
  }
  removeActiveTransition();
  return booleanValue(env, true);
}

napi_value cancelTransition(napi_env env, napi_callback_info info) {
  return finishTransition(env, info);
}

napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"cacheSnapshot", nullptr, cacheSnapshot, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"hasSnapshot", nullptr, hasSnapshot, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"beginTransition", nullptr, beginTransition, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"finishTransition", nullptr, finishTransition, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"cancelTransition", nullptr, cancelTransition, nullptr, nullptr, nullptr,
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
