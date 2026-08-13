#pragma once

#ifdef __cplusplus
extern "C" {
#endif

// The CEF Views window handle is an NSView* on macOS. The overlay is kept in
// a separate AppKit child panel so it never participates in CEF page captures
// or DevTools input dispatch.
void UfoAgentOverlaySet(void* cef_view_handle, bool active, const char* label);
void UfoAgentOverlayClear(void* cef_view_handle);

#ifdef __cplusplus
}
#endif
