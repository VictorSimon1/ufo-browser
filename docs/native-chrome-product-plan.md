# Native Chrome Product Plan

This branch is the Native Chrome-feel track for making UFO-Browser a real CEF/Chrome
Runtime application while keeping the existing UFO Agent, Skill, CLI, Task
Space, Profile, login-state, Overview, and control-overlay contracts intact.

## Product invariants

- The visible browser shell is Chromium's native Chrome Runtime. Address bar,
  tabs, navigation, profile controls, popups, dialogs, focus, and compositor
  behavior must not be recreated as HTML or Electron views.
- UFO owns the Agent protocol, Space leases, profile selection/import/sync,
  snapshots, screenshots, locator recovery, previews, and human/Agent input
  isolation.
- Agent screenshots and CDP input must never see or be blocked by the AppKit
  overlay. The overlay exists only in the outer native application layer to
  intercept human input.
- A cold Space must not start a visible window or steal focus. Opening a Space
  is the explicit presentation transition from Overview to its native Chrome
  window; closing it returns to Overview.
- Overview previews use one global low-frequency, change-driven budget. They
  must not create one live high-frame-rate compositor per Space.
- Electron remains only as a migration fallback until every Native acceptance
  gate is green. It is not a product runtime dependency on the Native path.

## Final host boundary (must not regress)

The final product is one UFO native host, not an Overview process plus one
`ufo-cef-host` process for every Space. The UFO host owns the Agent scheduler,
Space scheduler, Overview surface, presentation state, and all human/Agent
input policy. CEF is embedded in that host as the page/compositor layer.

In the packaged product the `UFO-Browser` bundle executable is that CEF host;
there is no outer AppKit launcher and no separately launched browser host. The
Node Agent service is an internal child service attached to the already-running
UFO host over private sockets and is forbidden from spawning another CEF main
process. Chromium GPU/Renderer/Utility helpers remain normal Chromium child
processes and are not Space hosts.

Each logical Space still gets its own CEF `CefRequestContext`/profile data
root and its own CDP target route. Isolation is logical and persistent-data
safe; it must not be implemented by launching another UFO/CEF application or
CEF main process for every Space. Public CEF Chrome Runtime supports only one
Chrome-style BrowserView per `CefWindow`, so the shared Host owns internal
Overview/Space windows and the Presentation Coordinator exposes exactly one
of them to the human at a time. Background Spaces remain alive only when their
lifecycle requires it; their windows are compositor-backed, transparent, and
non-interactive rather than additional visible product windows.

The former per-Space native host process was a migration scaffold only. The
shared Host is now the required architecture. Release evidence must prove both
that all Spaces route to the same CEF Host process and that no presentation
transition exposes more than one human-interactive native window.

## Current implementation

The branch starts from the Native CEF product runtime on
`codex/native-chrome-feel` and validates the latest stable CEF selected by the
repository tooling. The current local validation target is CEF
`151.3.17+gf059e67+chromium-151.0.7922.138`; CEF binaries remain ignored and
are never copied into Git.

Already covered by the Native vertical slice:

- CEF Chrome Runtime with `CEF_CTT_NORMAL` toolbar for human-facing Spaces;
- explicit `--chrome-shell` launch contract so every human-facing Space cannot
  silently fall back to a page-only shell;
- native Spaces button routed through a private presentation socket so a human
  can return to Overview without bypassing the UFO presentation coordinator;
- per-window native Space/Profile metadata with controls attached only to the
  currently presented warm Space, so background creation, popup close, and
  Space switching cannot steal or remove the visible UFO controls;
- native tabs, omnibox, navigation, profile menu, dialogs, and popup lifecycle;
- UFO-owned Node Agent child service and the existing `ufo-browser nodejs` protocol;
- isolated persistent/temporary Spaces and profile-aware CEF user-data roots;
- Chrome login-state import, Cookie writes, storage checkpoints, and sync;
- Overview API/renderer, global four-second preview cadence, and presentation
  transitions;
- outer AppKit Agent-control overlay and native input interception;
- ownership-persistent AppKit control capsule with explicit human takeover and
  task termination routed through the UFO lease/state machine;
- drag-installable Native DMG with bundled Node, CLI, Skill, CEF host/helpers.

## Migration phases

### Phase 1 — Native product shell (current)

Keep Agent contracts unchanged, make CEF version selection reproducible, build
against the latest stable CEF, and verify a relocated DMG bundle starts without
Electron. Human-facing Spaces now pass an explicit `--chrome-shell` switch and
the CEF host defaults non-Overview windows to the same native Chrome toolbar;
Overview remains a purpose-built management surface without browser chrome.
The branch adds a version smoke that asserts the actual Chromium version
returned by the running CEF host and command-line tests that protect this split.

### Phase 2 — Private CEF Agent transport

Replace the development-only loopback DevTools HTTP/WebSocket adapter with a
per-runtime Unix-socket bridge backed by `CefBrowserHost::SendDevToolsMessage`
and `CefDevToolsMessageObserver`. The first browser-level slice is now
implemented and verified for `Browser.getVersion` and `Target.getTargets`.
The Node side keeps the existing `CdpTransport` and multiplexed Agent protocol,
so Skill callers do not change. Page target attachment, OOPIF sessions, and
event parity remain explicitly opt-in until their CEF Chrome Runtime
`Target.sendMessageToTarget` behavior passes a dedicated suite; the tested
CDP adapter remains the default during this transition.

### Phase 3 — Full lifecycle and profile acceptance

Run long-lived multi-Space tests, restart tests, real Chrome Profile import
with user-approved Keychain/Touch ID, popup and tab semantics, overlay handoff,
and close/return-to-Overview failure recovery. Prove GPU/compositor use is
bounded by the global preview budget and no destroyed native window is
referenced during shutdown.

### Phase 4 — Release replacement

Sign the complete CEF framework/helper bundle, notarize it, install the DMG in
a clean `/Applications` location, synchronize the CLI and Agent Skills, and
verify the process tree contains no Electron. Only after these gates pass will
Electron be removed from the formal release path.

## Commands and evidence

```bash
npm run native:cef:fetch
npm run native:cef:configure
npm run native:cef:build
npm run native:cef:version:smoke
npm run native:cef:private:smoke
npm run native:cef:agent:smoke
npm run native:cef:profile:smoke
npm run native:cef:app:smoke
npm run native:cef:bundle:smoke
```

The version smoke is runtime-based: it asks the actual native host for
`Browser.getVersion` and rejects a stale CEF build even if compilation
otherwise succeeds.

The private bridge can be exercised by setting
`UFO_CEF_PRIVATE_BRIDGE=1` in an isolated development run. The current smoke
deliberately gates only browser-level commands; the normal Agent path remains
the default until page-target attachment, OOPIF routing, event subscriptions,
and screenshot/input commands all pass the parity suite.
