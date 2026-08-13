# UFO-Browser Native Chrome Host (prototype)

This directory contains the first native-host prototype for the Chrome-style
browser shell. It is deliberately separate from the Electron product path so
that the existing Agent, Profile, Task Space, and preview behavior remains
available while the native runtime is evaluated.

The host uses CEF's Chrome runtime and Views framework. The address bar,
navigation controls, profile menu, dialogs, and browser window are provided by
Chromium rather than by UFO-Browser HTML/CSS.

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

The port is a temporary prototype transport. It must not be enabled in a
release build; the production bridge will be a private Unix-socket/CEF
DevTools adapter with the same UFO Agent API and lease checks.

The full migration boundary and acceptance gates are documented in
`docs/native-chrome-runtime.md`.
