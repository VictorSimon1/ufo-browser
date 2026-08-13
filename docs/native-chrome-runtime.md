# Native Chrome Runtime migration

UFO-Browser is migrating to a CEF-first native application. The existing
Electron application is retained only as a development fallback while the
native path reaches feature parity. The browser window itself must be CEF's
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

During development, the native prototype can expose a localhost DevTools
port with `--agent-devtools-port`. Release builds must not expose a public
debugging port; the production adapter will bind the existing private Agent
transport and validate the Space lease before every operation. The standalone
Agent Service owns no browser UI, so the final product can be Electron-free.

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

## Build and run

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
existing Electron path remains a fallback until the acceptance gates pass;
it is not the final browser UI.

## Acceptance gates

- Native host opens a real Chromium page and handles close/reopen without a
  destroyed-window exception.
- Agent Skill calls produce the same observable results through the CEF bridge
  as they do through the current Electron implementation.
- Profile isolation and imported login state survive restart.
- Agent control overlay blocks humans but does not affect CDP screenshots or
  input.
- Overview preview cadence remains global and bounded when multiple Spaces
  exist.
- Packaging, signing, DMG installation, CLI sync, and Skill sync pass before
  the native host can replace the Electron browser shell.
