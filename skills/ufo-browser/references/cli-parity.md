# UFO-Browser CLI parity with Ego 0.4.5.9

The reference installed during the current audit is Ego App `0.4.5.9` with
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
| Native fetch | Callable, enumerable global | Same | UFO additionally exposes `fetch.server` and `fetch.browser`. |
| Version result | `{ currentVersion, updateAvailable }` | Same shape | UFO reports its own version and never claims to be Ego. |
| Profile result | `{ profiles: [{ id, isDefault, name }] }` | Same shape | Default profile id is `Default`; the display name remains UFO-branded. |
| `createTab(url)` | Requires a string and returns `{ targetId }` | Same | Missing arguments throw the same `TypeError` text before RPC. |
| Task Spaces | list, create/reuse, claim, handoff, takeover, complete | Aligned | UFO additionally enforces a generation lease on every host mutation and CDP command. |
| Tabs and navigation | list, reuse/open, switch, close, wait | Aligned | Internal file paths are hidden behind `x-browser://newtab/`. |
| Semantic snapshots | full AX tree, refs, stable locators | Aligned | Cross-site iframe refs route through the owning OOPIF session. |
| Pointer and keyboard input | selectors, refs, locators, coordinates, trusted input | Aligned | UFO uses Chromium CDP and never moves the macOS pointer. |
| Screenshots and fetch | page capture, browser fetch, server fetch | Aligned | The same fixture produces equal data and valid PNGs. |
| Request/response waits | Not injected as flat globals in Ego 0.4.5.9 | `waitForRequest`, `waitForResponse` | Deliberate forward-compatible UFO extension. |
| Flat download/screencast aliases | Not injected in either audited runtime | Structured UFO facades remain available | Not part of the shared installed contract. |

## Latest measured workflow

On the local parity fixture captured on 2026-08-07:

| Runtime | In-script total | CLI process elapsed |
|---|---:|---:|
| Ego 0.4.5.9 | 1572.0 ms | 1712.7 ms |
| UFO-Browser 0.1.0 | 859.3 ms | 1495.2 ms |

The measured UFO in-script ratio was `0.547×` Ego. The gate also rejects a
future UFO workflow that exceeds the bounded comparative budget. Timings are
diagnostic rather than a universal benchmark; correctness, focus isolation,
GPU parking, and live-preview tests remain separate hard gates.

## Deliberate differences

- The executable and Skill name are `ufo-browser`; no Ego package or runtime is
  loaded by the product.
- The legacy `x-browser` executable remains as a compatibility alias.
- Stable `EGO_*` error codes remain accepted for script compatibility.
- Profile/Cookie import is intentionally deferred; normal Spaces share the
  UFO-Browser profile partition.
- UFO adds bounded Overview rendering, preview caching, and adaptive GPU
  cadence outside the shared CLI contract.
