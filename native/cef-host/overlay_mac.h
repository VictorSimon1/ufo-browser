#pragma once

#ifdef __cplusplus
extern "C" {
#endif

// The CEF Views window handle is an NSView* on macOS. The overlay is kept in
// a separate AppKit child panel so it never participates in CEF page captures
// or DevTools input dispatch.
void UfoAgentOverlaySet(void* cef_view_handle,
                        bool active,
                        const char* label,
                        int space_id,
                        const char* presentation_socket);
void UfoAgentOverlayClear(void* cef_view_handle);
bool UfoAgentOverlayIsActiveForWindow(void* cef_view_handle);
bool UfoAgentOverlayHasActionsForWindow(void* cef_view_handle);
bool UfoAgentOverlayOwnsWindow(void* ns_window);

// Presentation and compositor scheduling are separate. A non-presented window
// is transparent and ignores human events; Agent-owned windows may stay
// compositor-awake, while ordinary warm background windows can be ordered out
// until an on-demand preview or presentation wakes them again.
void UfoCefWindowSetPresented(void* cef_view_handle, bool presented);
bool UfoCefWindowIsPresented(void* cef_view_handle);
void UfoCefWindowFocus(void* cef_view_handle);
void UfoCefWindowSetCompositorAwake(void* cef_view_handle, bool awake);
bool UfoCefWindowIsCompositorAwake(void* cef_view_handle);

// The Overview NSWindow is UFO's persistent product controller. Native Chrome
// Space windows are mounted over this controller at the exact same frame and
// move/resize with it, so presentation is an in-place surface transition
// instead of jumping to an unrelated top-level window.
void UfoCefProductControllerSet(void* cef_view_handle);
void UfoCefProductControllerClear(void* cef_view_handle);
bool UfoCefWindowIsMountedInProductController(void* cef_view_handle);

// Add the small native Spaces button used by human-facing Chrome shells. It
// sends presentation commands to UFO over a private Unix socket and is never
// part of the CEF page/compositor screenshot path.
void UfoCefShellControlsSet(void* cef_view_handle, const char* presentation_socket);
bool UfoCefShellControlsArePresentedForWindow(void* cef_view_handle);

// Chromium owns the native Chrome window and its traffic-light buttons. Route
// the close button back through UFO's durable Space state machine instead of
// allowing AppKit/Chromium to destroy the window behind the coordinator.
void UfoCefNativeSpaceWindowSet(void* cef_view_handle,
                                int space_id,
                                const char* presentation_socket,
                                bool agent_active);
void UfoCefNativeSpaceWindowSetAgentActive(void* cef_view_handle,
                                           bool agent_active);
void UfoCefNativeSpaceWindowClear(void* cef_view_handle);
bool UfoCefNativeSpaceWindowIsCloseRouted(void* cef_view_handle);
bool UfoCefNativeSpaceWindowIsCloseEnabled(void* cef_view_handle);

void UfoCefSpaceControllerSet(void* cef_view_handle,
                              const char* space_name,
                              const char* profile_name,
                              const char* presentation_socket);
void UfoCefChromeControlsClear(void* cef_view_handle);
bool UfoCefChromeControlsArePresentedForWindow(void* cef_view_handle);
bool UfoCefChromeControlsOwnWindow(void* ns_window);
void UfoCefRequestSpaceClose(int space_id, const char* presentation_socket);
void UfoCefRequestProductTermination();

// Ask Chromium's ProcessSingleton to create a native window for an existing
// Chrome Profile inside the already-running UFO CEF host. The short-lived
// forwarding process exits after handing the request to the primary process.
bool UfoCefOpenChromeProfileWindow(const char* executable,
                                   const char* user_data_root,
                                   const char* profile_directory,
                                   const char* url,
                                   bool use_mock_keychain);

#ifdef __cplusplus
}
#endif
