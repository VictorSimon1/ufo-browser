# Native Chrome Product Plan

This branch is the migration track for making UFO-Browser a real CEF/Chrome
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

## Current implementation

The branch starts from the Native CEF product runtime on
`codex/native-chrome-next` and validates the latest stable CEF selected by the
repository tooling. The current local validation target is CEF
`151.3.17+gf059e67+chromium-151.0.7922.138`; CEF binaries remain ignored and
are never copied into Git.

Already covered by the Native vertical slice:

- CEF Chrome Runtime with `CEF_CTT_NORMAL` toolbar for human-facing Spaces;
- native tabs, omnibox, navigation, profile menu, dialogs, and popup lifecycle;
- standalone Node Agent service and the existing `ufo-browser nodejs` protocol;
- isolated persistent/temporary Spaces and profile-aware CEF user-data roots;
- Chrome login-state import, Cookie writes, storage checkpoints, and sync;
- Overview API/renderer, global four-second preview cadence, and presentation
  transitions;
- outer AppKit Agent-control overlay and native input interception;
- drag-installable Native DMG with bundled Node, CLI, Skill, CEF host/helpers.

## Migration phases

### Phase 1 — Native product shell (current)

Keep Agent contracts unchanged, make CEF version selection reproducible, build
against the latest stable CEF, and verify a relocated DMG bundle starts without
Electron. The branch adds a version smoke that asserts the actual Chromium
version returned by the running CEF host.

### Phase 2 — Private CEF Agent transport

Replace the development-only loopback DevTools HTTP/WebSocket adapter with a
per-runtime Unix-socket bridge backed by `CefBrowserHost::SendDevToolsMessage`
and `CefDevToolsMessageObserver`. The Node side keeps the existing
`CdpTransport` and multiplexed Agent protocol, so Skill callers do not change.
During the transition the bridge is selected explicitly and the CDP adapter
remains a verified fallback until page targets, OOPIF sessions, events, and
Browser-level commands have parity tests.

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
npm run native:cef:agent:smoke
npm run native:cef:app:smoke
npm run native:cef:bundle:smoke
```

The version smoke is runtime-based: it asks the actual native host for
`Browser.getVersion` and rejects a stale CEF build even if compilation
otherwise succeeds.
