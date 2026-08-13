# UFO-Browser Native Chrome Host (prototype)

This directory contains the first native-host prototype for the Chrome-style
browser shell. It is deliberately separate from the Electron product path so
that the existing Agent, Profile, Task Space, and preview behavior remains
available while the native runtime is evaluated.

The host uses CEF's Chrome runtime and Views framework. The address bar,
navigation controls, Profile menu, dialogs, tabs, and browser window are
provided by Chromium rather than by UFO-Browser HTML/CSS. The delegate opts
into `CEF_CTT_NORMAL`; without that explicit opt-in CEF intentionally creates a
Chrome-style page window with no toolbar.

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

Space hosts start hidden by default and are shown through the private control
socket only when Overview opens or focuses that Space. Pass `--show-on-start`
for a standalone human-facing development window. This avoids the cold-start
flash and focus steal that would otherwise occur before the Presentation
Coordinator applies Space visibility.

The port is a temporary prototype transport. It must not be enabled in a
release build; the production bridge will be a private Unix-socket/CEF
DevTools adapter with the same UFO Agent API and lease checks.

The full migration boundary and acceptance gates are documented in
`docs/native-chrome-runtime.md`.
