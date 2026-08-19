# UFO-Browser CLI parity with Ego 0.4.6.12

The reference installed during the current audit is Ego App `0.4.6.12` with
Ego Skill `1.2.3`. The regression command is:

```bash
npm run verify:helper-parity
```

It sends the same heredoc program to both CLIs, compares the shared global
contract and observable browser result, captures screenshots, and records
operation timings in
`.x-browser-test/runs/helper-parity/helper-parity-audit.json`.

## Capability matrix

| Area | Installed Ego | UFO-Browser | Status |
|---|---|---|---|
| Heredoc execution | `ego-browser nodejs` | `ufo-browser nodejs` | Same async global-helper model and legal local name shadowing. |
| Host aliases | `createTab`, `getBrowserVersion`, `listProfiles`, `markTaskSpaceError`, `sendCDPMessage`, `setAgentTaskState`, `animationHighlightMouseToPosition` | Same | Installed as writable, configurable, non-enumerable globals. |
| Runtime iframe lookup | `iframeTarget` | Same | Flat global and `browser.iframeTarget(...)` are available. |
| Native fetch | Callable, enumerable global | Same | UFO additionally exposes `fetch.server`, renderer `fetch.browser`, and Profile-aware `fetch.profile` / `page.request`. |
| Version result | `{ currentVersion, updateAvailable }` | Same shape | UFO reports its own version and never claims to be Ego. |
| Profile result | `{ profiles: [{ id, isDefault, name }] }` | Same shape plus built-in `Temporary` entry | Default profile id is `Default`; `Temporary` selects a fresh one-time Session without changing the persistent default. |
| `createTab(url)` | Requires a string and returns `{ targetId }` | Same | Missing arguments throw the same `TypeError` text before RPC. |
| Task Spaces | list, create/reuse, claim, handoff, takeover, complete | Aligned | UFO additionally enforces a generation lease on every host mutation and CDP command. |
| Tabs and navigation | list, reuse/open, switch, close, wait | Aligned | Internal file paths are hidden behind `x-browser://newtab/`. |
| Semantic snapshots | full AX tree, refs, stable locators | Aligned | Cross-site iframe refs route through the owning OOPIF session. |
| Pointer and keyboard input | selectors, refs, locators, coordinates, trusted input | Aligned | UFO uses Chromium CDP and never moves the macOS pointer. |
| Screenshots and fetch | page capture, browser fetch, server fetch | Aligned | The same fixture produces equal data and valid PNGs. |
| Stale refs and strict locators | Latest-snapshot refs and locators | Extended | UFO refreshes stale refs through a unique locator and rejects ambiguous matches. |
| Frame locators | Iframe target lookup | `page.frameLocator` | Same-process, nested, and OOPIF actions use one locator surface. |
| Popup waits | Tab helpers | `page.waitForEvent('popup')` | Returns a popup facade while preserving tab isolation. |
| Request/response waits | Not injected as flat globals in Ego 0.4.6.12 | `waitForRequest`, `waitForResponse` | Deliberate forward-compatible UFO extension. |
| Profile-aware direct request | Not exposed by the audited runtime | `page.request`, `fetch.profile` | Main-process Chromium Session request with Profile Cookies/proxy/identity, Cookie writeback, no renderer/CORS dependency, bounded bodies, lease enforcement, and redacted events. |
| Request routing | Raw CDP available | `page.route`, `unroute`, `unrouteAll` | Glob/RegExp/predicate matching with continue/fulfill/abort. |
| Storage state | Profile login state reused implicitly | `page.storageState`, `setStorageState` | Explicit Cookie/current-origin localStorage export and restore; not Chrome profile decryption. |
| Performance tracing | Raw CDP available | `page.tracing.start`, `stop` | Writes Chrome Trace/Perfetto-compatible JSON. |
| Persistent action diagnostics | Current-process events | `taskSpaces.events` and `taskSpaces.trace` | Deliberate UFO extension with bounded, redacted, restart-safe cursors. |
| Deterministic Workflow replay | Not exposed by the audited runtime | `workflows.start/replay/list/get` | Deliberate UFO extension; versioned local Recipes, persistent Action Cache with hit/miss/fallback statistics, finite locator recovery, secret slots, and high-risk approval. |
| Flat download/screencast aliases | Not injected in either audited runtime | Structured UFO facades remain available | Not part of the shared installed contract. |

## Latest measured workflow

On the local parity fixture captured on 2026-08-10 after the current reliability
and performance upgrade:

| Runtime | In-script total | CLI process elapsed |
|---|---:|---:|
| Ego 0.4.6.12 | 2587.2 ms | 3457.1 ms |
| UFO-Browser 0.1.4 | 499.9 ms | 801.3 ms |

The measured UFO in-script ratio was `0.193×` Ego. The gate also rejects a
future UFO workflow that exceeds the bounded comparative budget. Timings are
diagnostic rather than a universal benchmark; correctness, focus isolation,
GPU parking, and live-preview tests remain separate hard gates.

## Deliberate differences

- The executable and Skill name are `ufo-browser`; no Ego package or runtime is
  loaded by the product.
- The legacy `x-browser` executable remains as a compatibility alias.
- Stable `EGO_*` error codes remain accepted for script compatibility.
- UFO adds a built-in Temporary Profile and optional Profile selection to
  task-space creation. Persistent Spaces still share their chosen Profile;
  each Temporary Space owns a unique memory-backed Session and is never
  restored after restart.
- UFO adds bounded Overview rendering, preview caching, and adaptive GPU
  cadence outside the shared CLI contract.
- UFO adds Snapshot V2 deltas, persistent Agent diagnostics, and local
  deterministic Workflow replay. These are additive facades; they do not
  rename or change the shared Ego-compatible helper surface.
