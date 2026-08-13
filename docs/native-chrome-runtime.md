# Native Chrome Runtime migration

UFO-Browser uses a deliberately layered architecture. The existing Electron
application remains the product path while the native Chrome Runtime is
introduced behind a separate host. This lets us replace the browser shell
without throwing away the Agent, Skill, Profile, Cookie, or Task Space work.

## What is being replaced

The browser shell is the part that users see around a page:

- title bar and traffic-light window behavior;
- back, forward, reload, and address bar controls;
- tabs and new-tab behavior;
- profile menu and browser dialogs;
- the native Chromium compositor surface.

These controls should come from CEF's Chrome-style Views runtime. Recreating
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

## Target process model

```text
Agent CLI / Skill
       |
       v
Node AgentHost (existing UFO protocol)
       |
       | private Unix socket / validated task-space lease
       v
CEF Native Host (C++/Objective-C++)
       |
       v
Chromium page + CEF DevTools adapter
```

During development, the native prototype can expose a localhost DevTools
port with `--agent-devtools-port`. Release builds must not expose a public
debugging port; the production adapter will bind the existing private Agent
transport and validate the Space lease before every operation.

## Integration order

1. **Native shell prototype** — one CEF Chrome-style window, real navigation,
   popup handling, title updates, and graceful close.
2. **Agent bridge** — map the existing Agent API to CEF DevTools targets and
   preserve the current Skill call shapes.
3. **Profiles and login state** — create one `CefRequestContext` per Profile
   and write imported cookies through `CefCookieManager`. Existing Chrome
   decryption, compatibility preflight, rollback, and redacted reporting stay
   in the Node service; only the final Chromium write adapter changes.
4. **Task Spaces** — map each Space to a request context and a browser target;
   keep only the active Space as a live compositor surface.
5. **Overview and overlay** — retain low-frequency, change-driven previews and
   place the human-input blocking overlay in an outer native `NSPanel`/`NSView`
   so Agent CDP input and screenshots are never covered.
6. **Packaging** — build the CEF host, copy the framework/helpers/resources,
   sign the complete app bundle, and produce the normal drag-to-Applications
   DMG. The install flow then syncs CLI and Skills exactly as the Electron
   installer does today.

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

`native/cef-host` is intentionally independent of the Electron build. Until
the bridge and profile migration are complete, the existing Electron path is
the only production path and is not changed by this prototype.

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
