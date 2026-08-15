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

Each persistent UFO Profile maps to a real Chrome Runtime profile directory and
each Space keeps its own CDP/browser route. CEF 151's native Chrome Runtime has
one supported process-wide Chrome BrowserContext, so the packaged host binds it
to the selected default UFO Profile before CEF initialization. A persistent
Space using another Profile is opened through Chromium's ProfileManager inside
that same long-lived UFO host; the short ProcessSingleton forwarding request
exits immediately and is not another Space host. Every Temporary Space instead
gets its own cache-less CEF off-the-record RequestContext and still uses the
full native Chrome Runtime window. Spaces remain separate native windows,
durable records, ownership domains, and Agent routes.
Isolation must not be implemented by
leaving one long-running UFO/CEF application per Space. The Presentation
Coordinator exposes exactly one managed Space/Overview surface to the human at
a time; background Spaces remain alive only when their lifecycle requires it.

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

- Chromium-owned, native-hosted CEF Chrome Runtime windows for human-facing
  Spaces (`CefWindowInfo.runtime_style = CEF_RUNTIME_STYLE_CHROME`), including
  the real tab strip, new-tab button, omnibox, navigation controls, profile
  controls, Chrome menu, dialogs, and window behavior;
- one persistent UFO Overview controller window: a presented native Chrome
  Space is mounted at the controller's exact frame and follows its move/resize
  lifecycle, so opening a Space is an in-place surface transition rather than
  hiding Overview and jumping to an unrelated top-level window;
- the former `CefBrowserView + GetChromeToolbar()` shell remains available only
  as a diagnostic fallback with `UFO_BROWSER_NATIVE_CHROME_PRODUCT_SHELL=0`;
- native Spaces button routed through a private presentation socket so a human
  can return to Overview without bypassing the UFO presentation coordinator;
- per-window native Space/Profile metadata with controls attached only to the
  currently presented warm Space, so background creation, popup close, and
  Space switching cannot steal or remove the visible UFO controls;
- native tabs, omnibox, navigation, profile menu, dialogs, and popup lifecycle;
- UFO-owned Node Agent child service and the existing `ufo-browser nodejs` protocol;
- isolated persistent/temporary Spaces and profile-aware CEF user-data roots;
- Chrome login-state import, Cookie writes, storage checkpoints, and sync;
- end-to-end imported Profile application: the Native Profile smoke selects
  the imported Chrome Profile for a real Space, verifies its Cookie state
  through the Agent page route, restarts UFO, and verifies that the same Space
  retains the login state;
- packaged-host Profile binding: the bundle smoke preselects a persistent
  Profile and verifies that CEF's actual `profile-directory` is
  `UFO-<profileId>`, so imported storage is used by the renderer rather than
  merely copied beside it;
- Overview API/renderer, global four-second preview cadence, and presentation
  transitions;
- outer AppKit Agent-control overlay and native input interception;
- ownership-persistent AppKit control experience with the original neutral
  veil, low-frequency ambient sweep, bottom control bar, task text, Agent
  pointer, explicit human takeover, and task termination routed through the
  UFO lease/state machine;
- native close routing that locks Agent-owned Space close buttons, sends a
  user-owned Space through the durable Space/Presentation state machine, and
  terminates the full UFO process tree when Overview closes;
- stable primary/direct-tab routing, so the initial Chrome bootstrap tab is
  never mistaken for a requested Space page and closing the first native tab
  does not orphan the Space's Agent/CDP route while other Chrome tabs remain;
- bounded first-navigation repair: if Chrome publishes a target URL before its
  renderer leaves `about:blank`, UFO reissues that Space's requested navigation
  once and waits for the exact page to become interactive before creation is
  considered complete;
- real-Profile target isolation based on exact CEF WebContents routes and raw
  frame/opener relationships. OOPIF/iframe targets are remapped to the stable
  UFO tab id, so Agent snapshots and frameLocator calls include cross-origin
  child content without leaking Overview or sibling Spaces;
- graceful host-first shutdown, so Chromium storage/network helpers flush
  Profile and Cookie state before the process-group kill fallback;
- drag-installable Native DMG with bundled Node, CLI, Skill, CEF host/helpers.

## Migration phases

### Phase 1 — Native product shell

Keep Agent contracts unchanged, make CEF version selection reproducible, build
against the latest stable CEF, and verify a relocated DMG bundle starts without
Electron. Human-facing Spaces now use Chromium-owned native Chrome windows by
default; Overview remains a purpose-built management surface without browser
chrome.
The branch adds a version smoke that asserts the actual Chromium version
returned by the running CEF host and command-line tests that protect this split.

### Phase 2 — Private Agent transport

Keep UFO's Agent Unix socket as the only external automation surface. The
packaged CEF 151 host gives only its managed Node child a random loopback
DevTools endpoint so the Agent can attach to the exact page WebSocket without
binding commands to Chromium's internal top-chrome renderer. The CEF
Unix-socket bridge remains available for diagnostics and host metadata. The
Node side keeps the existing `CdpTransport` and multiplexed Agent protocol, so
Skill callers do not change.

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
npm run native:cef:product-shell:smoke
npm run native:cef:chrome-profile:probe
npm run native:cef:temporary-profile:smoke
npm run native:cef:agent:smoke
npm run native:cef:profile:smoke
npm run native:cef:app:smoke
npm run native:cef:target-budget:smoke
npm run native:cef:bundle:smoke
```

The version smoke is runtime-based: it asks the actual native host for
`Browser.getVersion` and rejects a stale CEF build even if compilation
otherwise succeeds.

`native:cef:target-budget:smoke` repeatedly enumerates a real Chrome Profile
Space through the Agent-facing runtime and asserts that the Chromium Renderer
population stays bounded. This protects the native Chrome feel from a subtle
regression where every preview/Agent target query opened another direct frame
route and increased compositor cost.

The private bridge can still be exercised in an isolated development run.
Packaged CEF 151 uses its managed child's random loopback page targets for the
normal Agent path; AppKit window capture supplies screenshots without including
the human-only Agent overlay.

## CEF Chrome Profile architecture

The native Chrome Product Shell is now the Native product default. Set
`UFO_BROWSER_NATIVE_CHROME_PRODUCT_SHELL=0` only for a diagnostic comparison
with the former application-owned CEF toolbar.
Custom persistent `CefRequestContext(cache_path)` objects are not used for
native Chrome windows in CEF 151 because they do not select another real Chrome
Profile and can leave the internal top-chrome renderer waiting for
browser-info. UFO maps each persistent Profile to a real directory (`Default`,
`UFO-<id>`, and so on), starts the packaged host's global BrowserContext on the
validated default Profile, and asks Chromium's in-process ProfileManager to
open any alternate persistent Profile. The forwarding invocation is only a
short-lived ProcessSingleton command and exits after the existing UFO host has
accepted it. Temporary Spaces use the supported exception: one unique
cache-less off-the-record CEF RequestContext per Space, created only after
`OnRequestContextInitialized`, with no reusable on-disk identity.

Target ownership follows the exact public page target created after each Space
request, plus frame/opener relationships and UFO's native browser registry.
This keeps Overview and sibling Spaces out of Agent tab enumeration even when
the process-wide BrowserContext and target list are shared.
