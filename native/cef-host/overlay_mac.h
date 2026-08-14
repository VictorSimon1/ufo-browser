#pragma once

#ifdef __cplusplus
extern "C" {
#endif

// The CEF Views window handle is an NSView* on macOS. The overlay is kept in
// a separate AppKit child panel so it never participates in CEF page captures
// or DevTools input dispatch.
void UfoAgentOverlaySet(void* cef_view_handle, bool active, const char* label);
void UfoAgentOverlayClear(void* cef_view_handle);

// Keep a native CEF window in the compositor while making it invisible to a
// human. Unlike Hide/orderOut, alpha=0 preserves CEF screenshot production and
// DevTools input for background Agent Spaces.
void UfoCefWindowSetPresented(void* cef_view_handle, bool presented);
bool UfoCefWindowIsPresented(void* cef_view_handle);

// Add the small native Spaces button used by human-facing Chrome shells. It
// sends presentation commands to UFO over a private Unix socket and is never
// part of the CEF page/compositor screenshot path.
void UfoCefShellControlsSet(void* cef_view_handle, const char* presentation_socket);
void UfoCefShellControlsClear();

void UfoCefSpaceControllerSet(void* cef_view_handle,
                              const char* space_name,
                              const char* profile_name,
                              const char* presentation_socket);
void UfoCefSpaceControllerClear();

#ifdef __cplusplus
}
#endif
