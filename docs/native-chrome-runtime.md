# Native Chrome Runtime

UFO-Browser's product runtime is CEF-first. The existing Electron application
is retained only as a development fallback for legacy tests and migration
rollback. The browser window itself is CEF's
Chrome Runtime; Electron must not redraw or embed a fake address bar.

## What is being replaced

The browser shell is the part that users see around a page:

- title bar and traffic-light window behavior;
- back, forward, reload, and address bar controls;
- tabs and new-tab behavior;
- profile menu and browser dialogs;
- the native Chromium compositor surface.

These controls come from CEF's Chrome-style Views runtime. Recreating
them in renderer HTML/CSS is visually close but does not provide the same
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

Ego Lite is used as a behavioral and visual reference. Its compiled framework
and private implementation are not product dependencies.

## Target process model (Electron-free product)

```text
Agent CLI / Skill
       |
       v
UFO Agent Service (Node, standalone)
       |
       | private Unix socket + validated Task Space lease
       v
CEF Native Host (C++/Objective-C++)
       |
       v
CEF Chrome Runtime (native tabs, omnibox, profile menu, dialogs, page)
```

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
2. **Standalone Agent bridge** — map the existing Agent API to CEF DevTools targets and
   preserve the current Skill call shapes.

   The first Electron-free vertical slice is now available during development:

   ```bash
   npm run native:cef:build
   npm run native:cef:agent:smoke
   ```

   `native-cef-agent` is a standalone Node process. It owns the private Agent
   Unix socket, starts one CEF Chrome Runtime per Space, and exposes the same
   `ufo-browser nodejs` helpers. The smoke covers bootstrap, `pageInfo`, `js`,
   `snapshotText`, screenshot capture, navigation, and completion. This is
   intentionally a vertical slice; multi-Space Overview and profile import are
   the next integration gates.
3. **Profiles and login state** — the current native vertical slice gives each
   Space a private CEF user-data directory, which avoids Chromium profile-lock
   races while preserving full browser persistence within that Space. The
   next profile gate will seed that directory from the selected UFO Profile
   and route Cookie/storage deltas through CEF's `CefCookieManager`. Existing
   Chrome decryption, compatibility preflight, rollback, and redacted
   reporting stay in the Node service; only the final Chromium write adapter
   changes. Native Spaces now seed a fresh persistent CEF directory once from
   the selected UFO Profile. The seed allowlists Chromium login/storage
   datasets and Cookie databases, skips password/history/extension data and
   singleton locks, and writes `.ufo-profile-seed.json` so an active native
   Space is never overwritten on a later launch. A shared persistent Profile
   runtime will be added only after the RequestContext/target lifecycle is
   implemented, rather than launching two CEF processes against one locked
   directory. Development smoke runs may set `UFO_CEF_USE_MOCK_KEYCHAIN=1`;
   release builds must use the signed macOS Keychain path instead of shipping
   the mock switch.
4. **Task Spaces** — map each Space to a request context and a browser target;
   keep only the active Space as a live compositor surface.
5. **Overview and overlay** — retain low-frequency, change-driven previews and
   place the human-input blocking overlay in an outer native `NSPanel`/`NSView`
   so Agent CDP input and screenshots are never covered.

   The native host now has a private per-Space control socket for `show`,
   `hide`, `focus`, `close`, and `status`. It is separate from the CDP port and
   is used by the future native Overview/presentation layer; the Agent still
   talks through the existing UFO Unix socket.

   The first native overlay slice is now implemented. Agent lease acquisition
   sends `agent-active-on` to the CEF host, which installs a transparent AppKit
   child panel above the CEF window. The panel draws only a small neutral,
   lightly pulsing control capsule, consumes human mouse/keyboard events, and
   does not enter the CEF compositor or page screenshot path. Lease release,
   handoff, close, and host shutdown send `agent-active-off`/clear and remove
   the panel. A cold Space is started lazily when an Agent first acquires its
   lease so the overlay state cannot be skipped on first entry.
6. **Electron removal and packaging** — build the CEF host plus standalone
   Agent Service, copy the framework/helpers/resources,
   sign the complete app bundle, and produce the normal drag-to-Applications
   DMG. The install flow then syncs CLI and Skills exactly as the Electron
   installer does today.

   A native launcher/package prototype is now available:

   ```bash
   npm run package:native:mac
   ```

   It creates `release-native/UFO-Browser.app` and a drag-install DMG without
   Electron Builder. The bundle contains the AppKit launcher, standalone Node
   Agent, CEF host, CEF Framework/Helpers, UFO CLI and Skill. The launcher
   starts the Agent first, waits for its Overview API rendezvous file, and
   then starts the native CEF Overview window. This prototype is not yet
   signed/notarized and still needs production entitlements, helper signing,
   and post-install CLI/Skill synchronization before replacing the release
   Electron package.

   Native presentation is now coordinated explicitly instead of letting each
   CEF window show itself independently. Opening a Space hides Overview and
   all other running Space windows; closing the visible Space returns to and
   focuses Overview. Background Spaces keep their Chromium state but remain
   hidden, and cold Spaces are still started only when opened or used by an
   Agent. Control sockets live in a short per-Agent temporary directory to
   stay below macOS `sockaddr_un` path limits even when Profile data lives in a
   deeply nested directory. Run `npm run native:cef:presentation:smoke` for the
   create/open/close/return lifecycle gate.

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
   root. The packaged CEF host lives at `Contents/MacOS/ufo-cef-host`, beside the
   AppKit launcher. This is intentional: CEF's generated executable rpath is
   relative to `Contents/MacOS`, so moving the host into `Resources` would
   break Framework loading after a drag-install. The launcher starts the
   standalone Agent with the bundled Node runtime, then the Agent starts the
   CEF Overview and Space hosts. No Electron process is required by the native
   bundle.

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
contains the CEF framework, native Chrome host, standalone Node Agent, CLI,
and Skill. Installing it does not start Electron; the existing
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
- Agent control overlay blocks humans but does not affect CDP screenshots or
  input.
- Overview preview cadence remains global and bounded when multiple Spaces
  exist.
- Packaging, signing, DMG installation, CLI sync, and Skill sync pass before
  the native host can replace the Electron browser shell.
