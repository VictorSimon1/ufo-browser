# UFO-Browser Native Chrome Host

This directory contains the native Chrome Runtime host used by the Native
product path. It is deliberately isolated from the legacy Electron fallback so
the existing Agent, Profile, Task Space, and preview contracts remain stable
during migration.

The host uses CEF's Chrome runtime and Views framework. The address bar,
navigation controls, Profile menu, dialogs, tabs, and browser window are
provided by Chromium rather than by UFO-Browser HTML/CSS. The delegate opts
into `CEF_CTT_NORMAL`; without that explicit opt-in CEF intentionally creates a
Chrome-style page window with no toolbar.

The surrounding Space controller is still owned by UFO: Space name, Profile,
and return-to-Spaces are drawn by AppKit in the native titlebar. It is not an
HTML overlay and never participates in page screenshots or Agent/CDP input.
Each warm Space keeps only its own controller metadata. The actual AppKit
panels are mounted on the one human-presented Space and move with presentation,
so background Space/popup lifecycle cannot disturb the visible controls.

When an Agent owns the presented Space, an outer AppKit panel blocks human
page/toolbar input while leaving CEF screenshots and DevTools input untouched.
Its native capsule exposes only two state-machine actions: **接管** and
**终止任务**. The overlay follows persistent Space ownership, so it remains
present after a short-lived CLI process exits.

## Build

The build requires a full Xcode installation (not only Command Line Tools),
CMake 3.21+, Ninja, and a matching CEF binary distribution.

```bash
UFO_CEF_ROOT=/absolute/path/to/cef_binary_144.0.6+g5f7e671+chromium-144.0.7559.59_macosarm64 \
  npm run native:cef:build
```

When the local comparison fixture from `test/cef-runtime` exists, the build
script discovers it automatically. The CEF binaries are intentionally not
checked into the UFO-Browser repository.

## Run

```bash
npm run native:cef:run -- --url=https://example.com
```

For the development-only Agent bridge, request an explicit localhost DevTools
port:

```bash
npm run native:cef:run -- \
  --url=https://example.com \
  --agent-devtools-port=9222
```

The host also accepts `--user-data-dir=/absolute/path` for isolated
development profiles. Production Profile/Space creation will supply this
directory through the private Agent bridge rather than sharing CEF's default
cache location.

The packaged Native app defaults to `~/Library/Application Support/UFO-Browser`
so existing imported Profiles and the standard `ufo-browser` CLI socket remain
compatible with the current product. Set `UFO_BROWSER_NATIVE_USER_DATA` for an
isolated development instance.

The DMG also bundles the storage-revision Worker next to the Native Agent;
login-state storage synchronization therefore does not depend on the source
checkout after installation.

The product starts one shared CEF Host for Overview and every Space. Space
surfaces start transparent and non-interactive inside that Host and are
presented through the private control socket only when Overview opens or
focuses the Space. Pass `--show-on-start` only for a standalone host diagnostic.
This avoids cold-start flash and focus steal before the Presentation
Coordinator applies the single-visible-surface state.

In a packaged build this host binary is the `UFO-Browser.app` main executable,
not a child launched by a wrapper app. It owns an internal Node Agent service;
that service attaches to the host's private sockets and never starts another
CEF browser process.

The port is a temporary prototype transport. It must not be enabled in a
release build; the production bridge will be a private Unix-socket/CEF
DevTools adapter with the same UFO Agent API and lease checks.

The full migration boundary and acceptance gates are documented in
`docs/native-chrome-runtime.md`.
