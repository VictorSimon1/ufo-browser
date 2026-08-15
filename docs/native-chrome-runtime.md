# Native Chrome Runtime

UFO-Browser's product runtime is CEF-first. The existing Electron application
is retained only as a development fallback for legacy tests and migration
rollback. The browser window itself is CEF's native-hosted Chrome Runtime;
Electron must not redraw or embed a fake address bar. Human-facing Spaces are
created with `CefWindowInfo.runtime_style = CEF_RUNTIME_STYLE_CHROME`, which
lets Chromium own the real tab strip, new-tab button, omnibox, toolbar, menus,
and window. Overview remains
the UFO management surface and intentionally has no browser toolbar.
Each human-facing Space also gets a small native Spaces button above the CEF
toolbar. It sends `show-overview` through a separate private Unix socket to
the UFO Presentation Coordinator, so returning to Overview hides the current
Space through the same single-surface state machine instead of merely exposing
another window.

## What is being replaced

The browser shell is the part that users see around a page:

- title bar and traffic-light window behavior;
- back, forward, reload, and address bar controls;
- tabs and new-tab behavior;
- profile menu and browser dialogs;
- the native Chromium compositor surface.

These controls come from CEF's Chromium-owned native Chrome runtime. The
earlier `CefBrowserView + GetChromeToolbar()` implementation exposed only a
toolbar and could never provide Chrome's real tab strip. Recreating them in
renderer HTML/CSS is visually close but does not provide the same
window lifecycle, accessibility tree, popup behavior, input routing, or GPU
composition as a Chromium browser window.

## What stays in UFO-Browser

The following remains owned by UFO-Browser and is not copied from Ego Lite:

- the Node AgentHost and private Unix-socket protocol;
- the `ufo-browser` Skill and CLI contract;
- Task Space creation, leases, completion, and cleanup;
- Profile selection and Chrome login-state import;
- stale-ref recovery, locator disambiguation, snapshots, screenshots, and
  actionability recovery;
- Overview state, low-frequency change-driven previews, and presentation state;
- the native macOS agent-control overlay.

The release target uses one shared UFO CEF host process for Overview and every
Space. A Space never launches another `ufo-cef-host` application or CEF main
process. Isolated Space RequestContexts are held by separate Chromium-owned
native Chrome windows inside that
single Host. UFO's Presentation Coordinator guarantees that exactly one of
those managed surfaces is presented to the human. Agent-owned background
Spaces stay compositor-awake for uninterrupted CDP input and screenshots;
ordinary warm background Spaces keep their Chromium state but are ordered out
at the AppKit layer so their windowed compositor can sleep.

Ego Lite is used as a behavioral and visual reference. Its compiled framework
and private implementation are not product dependencies.

## Target process model (Electron-free product)

```text
Agent CLI / Skill
       |
       v
UFO-Browser main executable (CEF browser host)
       |
       +-- Overview + every Space (one shared CEF main process)
       |
       +-- UFO Agent Service (managed internal child service)
       |
       | private Unix socket + validated Task Space lease
       v
CEF Chrome Runtime (native tabs, omnibox, profile menu, dialogs, page)
```

The packaged bundle launches the CEF Native Host directly as `UFO-Browser`.
It starts and owns the Node Agent service, which attaches back to that existing
host and cannot launch another browser host. All Spaces live in the same UFO
CEF main process. A Space is an isolated request context, target route, and
internally managed Chrome surface—not a new application/CEF process. The
native presentation invariant is one human-presented UFO surface at a time.
CEF's GPU/Renderer/Utility helpers are required Chromium subprocesses; they do
not own UFO scheduling or represent separately launched Spaces.

### Target enumeration budget

Real Chrome Profiles need one direct `Page.getFrameTree` lookup per exact CEF
WebContents route to map Chromium's process-wide target list back to a UFO
Space. That lookup is cached by `browserId`: normal navigation and repeated
Agent/Overview polling reuse the cached root/frame graph, while a missing root
target gets a short renderer-replacement grace period and then one fresh probe.
New OOPIFs are discovered from the process-wide parent graph without reopening
the route. This keeps the native Chrome compositor and DevTools browser-info
manager from being churned by preview cadence, while preserving exact
Profile/Space isolation and recovery when a tab or frame is genuinely replaced.

The production direction is a per-runtime private Unix-socket CEF DevTools
bridge. Its browser-level and page-level slices are verified for
`Browser.getVersion`, `Target.getTargets`, flattened `Target.attachToTarget`,
`Runtime.evaluate`, `Page.enable`, navigation readiness, and screenshots. The
bridge is now the default for Native Task Spaces. Set
`UFO_CEF_PRIVATE_BRIDGE=0` only for legacy diagnostics that explicitly need the
temporary loopback DevTools HTTP endpoint. OOPIF, popup, download, and
screenshot paths are covered by Native smoke tests. Page events now flow
through the same flattened synthetic sessions used by the Agent; console,
page-error, and Network request delivery are covered by a Native event smoke.
Packaged Native
launches do not expose a fixed or user-configurable endpoint. The Agent Unix
socket remains the only externally discoverable UFO control surface and
validates the Space lease before every operation. The standalone Agent Service
owns no browser UI, so the Native path is Electron-free at runtime.

## Integration order

1. **Native shell prototype** — one CEF Chrome-style window with
   `GetChromeToolbarType() == CEF_CTT_NORMAL`, real tabs, omnibox, profile
   menu, browser dialogs, popup handling, title updates, and graceful close.
2. **Managed Agent bridge** — map the existing Agent API to CEF DevTools targets and
   preserve the current Skill call shapes.

   The first Electron-free vertical slice is now available during development:

   ```bash
   npm run native:cef:build
   npm run native:cef:agent:smoke
   ```

   `native-cef-agent` is a UFO-managed Node service. In the packaged product it
   owns the private Agent Unix socket and attaches to the existing
   `UFO-Browser` CEF main process; it cannot start a second Host. It registers
   each Space as a managed native window and target route inside that Host and
   exposes the same `ufo-browser nodejs` helpers. The smoke covers
   bootstrap, `pageInfo`, `js`, `snapshotText`, screenshot capture, navigation,
   and completion.
3. **Profiles and login state** — persistent Spaces use real Chrome Runtime
   ProfileManager directories beneath the shared UFO user-data root. Two
   Spaces selecting the same UFO Profile share login state while keeping
   separate native windows and Agent routes; different Profiles have isolated,
   restart-persistent Cookies and storage. A short-lived executable invocation
   asks Chromium's ProcessSingleton to create the Profile window in the
   already-running UFO CEF host, then exits. Native Spaces seed an unused
   Profile directory once from the selected UFO Profile and route Cookie
   operations through the CEF/CDP adapter. The seed allowlists Chromium
   login/storage datasets, skips encrypted Cookie databases,
   password/history/extension data and singleton locks, and writes
   `.ufo-profile-seed.json` so an active native Profile is never overwritten.
   Decrypted Cookie import is also a one-time Profile initialization and writes
   `.ufo-cookie-seed.json`; only a matching marker with `reason: "imported"`
   counts as complete. Older migration markers are retried automatically, and
   the initial page is re-navigated before presentation so its first visible
   request uses the newly imported login state. Opening another Space with the
   same Profile never repeats the full Cookie transaction. Chromium-normalized legacy Cookie
   attributes may produce a partial verification warning during that first
   seed, but cannot make a Space flash and fall back to Overview. Later source
   changes use the normal hash/checkpoint Profile Sync path.
   Chrome import and UFO Profile
   clone create a short-lived, toolbar-free RequestContext inside the same UFO
   CEF Host; they no longer launch a second browser main process against the
   target directory. The internal transaction surface is never presented and
   is destroyed after Cookie verification. Development smoke runs may set
   `UFO_CEF_USE_MOCK_KEYCHAIN=1`; release builds must use the signed macOS
   Keychain path instead of shipping the mock switch.
4. **Task Spaces** — map each Space to a native Profile window and browser
   target in the one shared UFO Host. Keep the presented Space and Agent-owned Spaces
   compositor-awake; park ordinary warm background Space windows without
   destroying their tabs, RequestContexts, or page state.
5. **Overview and overlay** — retain low-frequency, change-driven previews and
   place the human-input blocking overlay in an outer native `NSPanel`/`NSView`
   so Agent CDP input and screenshots are never covered.

   The shared native Host has one private control socket. Space-scoped
   `show`, `hide`, `focus`, `close`, and `status` commands carry a Space id and
   are routed inside the Host. It is separate from the DevTools bridge; the
   Agent still talks through the existing UFO Unix socket.

   The native overlay is owned by persistent Space state, not by the lifetime
   of a short CLI socket. `ownership=agent` plus `lifecycle=active` installs a
   AppKit child panel above the presented CEF window; a CLI exit therefore
   cannot silently unlock the page. The panel draws the neutral dot-matrix
   veil, subtle blue edge light and low-frequency ambient sweep from the
   established UFO control experience, plus the bottom task bar, Agent pointer,
   and explicit **接管** / **终止任务** actions.
   Those actions route through the Presentation Coordinator, revoke the Agent
   lease/generation fence, and update ownership/lifecycle without closing the
   Space. The panel consumes all other human input and never enters the CEF
   compositor or page screenshot path, so Agent CDP input and screenshots are
   unaffected. Its animation runs at 10 FPS and invalidates only the moving
   sweep strips, bottom bar, and short-lived pointer rather than repainting or
   repositioning the complete window every frame.

   Run `npm run native:cef:overlay:smoke` to prove that the overlay survives a
   CLI disconnect, Agent input/screenshot still work behind it, takeover keeps
   the Space open, and termination ends the task and returns ownership to the
   user.
6. **Electron removal and packaging** — build the UFO CEF main executable plus
   its managed Agent Service, copy the framework/helpers/resources,
   sign the complete app bundle, and produce the normal drag-to-Applications
   DMG. The install flow then syncs CLI and Skills exactly as the Electron
   installer does today.

   The Native CEF package is the formal macOS product path:

   ```bash
   npm run package:native:mac
   ```

   It creates `release-native/UFO-Browser.app` and a drag-install DMG without
   Electron Builder or an Electron runtime. The bundle contains one
   `UFO-Browser` CEF main executable, its managed Node Agent service, CEF
   Framework/Helpers, UFO CLI and Skill. The main executable starts the Agent,
   waits for its Overview API rendezvous file, and then initializes its own
   native CEF Overview window. The
   post-install flow detects this native bundle and synchronizes the CLI and
   Skills into the installed Agent directories.

   Native presentation is now coordinated explicitly instead of letting each
   CEF window show itself independently. Opening a Space makes it the only
   human-presented surface and disables human input on Overview and all other
   running Space windows; closing the visible Space returns to and focuses
   Overview. An Agent-owned background Space remains transparent,
   non-interactive, and compositor-awake so automation never stalls. A normal
   warm background Space is `orderOut`-parked after the transition, preserving
   its Chromium state while allowing the native compositor to sleep. Overview
   previews use one global low-frequency queue: it wakes exactly the selected
   warm Space, captures one JPEG, and parks it again. Hidden Overview requests
   receive only the cached frame and cannot wake background Spaces. Cold
   Spaces are still started only when opened or used by an Agent. Control
   sockets live in a short per-Agent temporary directory to
   stay below macOS `sockaddr_un` path limits even when Profile data lives in a
   deeply nested directory. Run `npm run native:cef:presentation:smoke` for the
   create/open/close/return lifecycle gate, including assertions that the
   presented-window count never exceeds one and background compositors return
   to sleep after an on-demand preview.

   Native titlebar controls follow the same presentation state. Each Space
   window records its own Space name, Profile name, and presentation socket,
   but the AppKit Spaces/Space-Profile panels are attached only when that
   window becomes the one presented surface. A warm background Space or popup
   can therefore be created/closed without stealing or removing the controls
   from the visible Space. The shared Host intentionally uses the per-window
   role rather than its process-wide `--overview` switch; otherwise every
   Space created inside the Overview Host would incorrectly lose its controls.
   While an Agent owns the Space, these UFO controls remain above the blocking
   overlay and interactive; the Chromium toolbar and page stay locked.

   Native close buttons follow the same lifecycle rules. An Agent-owned Space
   rejects a titlebar close while still allowing window dragging. A user-owned
   Space routes the red-button close through the Presentation Coordinator,
   removes the durable Space record, closes its CEF surface, and returns to
   Overview. Closing Overview uses UFO's bounded product shutdown path so the
   CEF main process, managed Agent service, and Chromium helpers do not remain
   alive without a window.

   Process-level `--overview` and `--show-on-start` switches apply only to the
   initial main window. Shared Space and Profile-operation surfaces use their
   own per-window visibility role, so background Agent bootstrap, Profile
   import, and clone cannot flash another window in front of the user.

   Native Profile Cookie sync is also connected to the CEF Agent. A running
   persistent Space gets an independent Cookie checkpoint and receives source
   deltas through CEF CDP. A UFO-side logout remains a divergence and is not
   resurrected merely because the source profile is unchanged. Encrypted
   Chrome Cookie SQLite files are never copied between runtimes.

   Native storage sync follows the same non-destructive contract as the
   existing Profile sync service. It runs only before a CEF Space starts, never
   replaces LevelDB/SQLite data underneath a live renderer, skips a live Google
   Chrome source profile, establishes a hash-only baseline on first use, and
   copies later source changes only when the Native target still matches the
   checkpoint. If both sides changed, the Native/UFO target wins.

   Native uses the shared UFO-Browser data root by default so existing
   `profiles.json`, imported Chrome partitions, browser state, and the default
   Agent CLI socket continue to work after switching shells. Development
   smoke tests set `UFO_BROWSER_NATIVE_USER_DATA` to an isolated temporary
   root. The packaged CEF host is the bundle main executable at
   `Contents/MacOS/UFO-Browser`. Keeping it in `Contents/MacOS` preserves CEF's
   framework rpath after a drag-install. It starts the managed Agent with the
   bundled Node runtime; the Agent attaches to the existing host and cannot
   launch another CEF main process. No Electron or outer launcher process is
   required by the native bundle.

## Build and run

The native path does not require Electron at runtime. To fetch the latest
stable CEF distribution for the current Mac architecture and build it:

```bash
npm run native:cef:fetch
npm run native:cef:configure
npm run native:cef:build
npm run start:native
```

`native:cef:fetch` downloads the latest stable standard CEF archive into the
ignored `test/cef-runtime/` directory. Set `UFO_CEF_VERSION` to pin a known
release, or set `UFO_CEF_ROOT` to use an existing distribution. The current
validated runtime is CEF 151 / Chromium 151. The build script reconfigures
automatically when the selected CEF root changes, and
`npm run native:cef:version:smoke` verifies the running browser version instead
of relying only on a build-directory name. CEF binaries remain outside Git.

For a drag-installable native package:

```bash
npm run package:native
```

This produces `release-native/UFO-Browser-<version>-native.dmg`. The bundle
contains the CEF framework, the `UFO-Browser` native Chrome main executable,
its managed Agent service, CLI, and Skill. Installing it does not start
Electron; the existing
`install:mac` flow detects the native bundle and synchronizes the CLI and
Skills from it.

CEF binaries are intentionally excluded from Git. Set `UFO_CEF_ROOT` to a
matching distribution, or use the local comparison fixture under
`test/cef-runtime`:

```bash
npm run native:cef:configure
npm run native:cef:build
npm run native:cef:run -- --url=https://example.com
```

The macOS build requires full Xcode because CEF generates native `.nib`
resources with `ibtool`; Command Line Tools alone are insufficient:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

`native/cef-host` is intentionally independent of the Electron build. The
private bridge forwards Chrome Runtime's flattened `sessionId` envelope
directly; wrapping page commands in legacy `Target.sendMessageToTarget` caused
acknowledged commands to hang on newer CEF Chrome Runtime builds. The native
private smoke covers page evaluation, Page.enable, navigation readiness, and
screenshots. Native Overview windows are controlled by their private AppKit
control socket and do not expose a public DevTools port in packaged builds;
an Overview port is only enabled when an explicit development port is passed.
The Native runtime passes `--chrome-shell` for every human-facing Space. The
CEF host also defaults non-Overview direct launches to that same Chrome shell;
`--plain-page` is reserved for low-level host diagnostics and is not used by
the product or DMG.
The existing Electron path remains a migration fallback for
legacy tests until the acceptance gates pass; it is not used by the Native DMG
runtime and is not the final browser UI.

## Acceptance gates

- Native host opens a real Chromium page and handles close/reopen without a
  destroyed-window exception.
- Agent Skill calls produce the same observable results through the CEF bridge
  as they do through the current Electron implementation.
- Native Agent popup, download, and page-event behavior matches the existing
  Skill facade, including `page.waitForEvent("popup")`,
  `page.waitForEvent("download")`, console, pageerror, and request events.
- Profile isolation and imported login state survive restart.
  `native:cef:profile:smoke` must prove this through a selected real Space and
  Agent-visible page Cookie state, not merely through a successful import API
  response.
- The native Chrome Product Shell is the packaged product default. Real
  ProfileManager persistence and isolation are protected by
  `native:cef:chrome-profile:probe`; custom RequestContexts remain OTR-only.
- Agent control overlay blocks humans but does not affect CDP screenshots or
  input.
- Overview preview cadence remains global and bounded when multiple Spaces
  exist.
- Packaging, signing, DMG installation, CLI sync, and Skill sync pass before
  the native host can replace the Electron browser shell.
