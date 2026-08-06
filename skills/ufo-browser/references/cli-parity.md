# UFO-Browser CLI parity with Ego 1.2.6

## Capability matrix

| Area | Ego Skill / CLI | UFO-Browser | Notes |
|---|---|---|---|
| Heredoc execution | `ego-browser nodejs` | `ufo-browser nodejs` | Same async global-helper execution model; local helper-name shadowing remains legal. |
| Task spaces | list, create/reuse, claim, handoff, takeover, complete | Aligned | UFO-Browser additionally enforces a generation lease on every host mutation and CDP command. |
| Tabs and navigation | list, reuse/open, switch, close, wait | Aligned | Internal new-tab file paths are hidden behind `x-browser://newtab/`. |
| Semantic snapshots | full AX tree, refs, stable locators | Aligned | Cross-site iframe refs are collision-safe and route through the owning OOPIF session. |
| Pointer input | selector/ref/locator/coordinate click, hover, drag, wheel | Aligned | Input uses Chromium CDP, never OS-level mouse automation. |
| Keyboard and forms | press, type, fill, checkbox, select, events | Aligned | Trusted input is bounded by focus emulation and the visible Agent control layer. |
| Locator facade | CSS, XPath, role/text/label/test-id, filters | Aligned | Available through flat helpers and `page.locator(...)`. |
| Waits and events | selector, function, URL, load, request, response | Aligned | Compatibility aliases use seconds; raw facade methods use milliseconds. |
| Files and downloads | upload and download events | Aligned | Download routing is isolated to the owning connection and Space. |
| Screenshot and screencast | page/clip/full-page capture and video frames | Aligned | Overview preview has its own adaptive compositor budget and does not compete with Agent screencasts. |
| Evaluate and CDP | page JS, raw CDP, event drain | Aligned | Browser-level targets are scoped so another Space cannot be observed. |
| Fetch | Node-side and page-context requests | Aligned | `fetch` remains callable and also exposes `fetch.server` / `fetch.browser`. |
| Site skills | discovery, Node tools, browser tools, learned context | Aligned | Resources resolve from `skills/ufo-browser`, not from an Ego installation. |
| Help and facades | flat helpers plus page/browser/taskSpaces/site | Aligned | UFO-Browser keeps the complete flat compatibility surface and the structured facades. |

## Deliberate differences

- The executable and Skill name are `ufo-browser`; no `ego-lite` package or runtime is loaded.
- The legacy `x-browser` executable remains as a compatibility alias during the rename.
- Stable `EGO_*` error codes remain accepted for script compatibility even though the implementation is owned by UFO-Browser.
- Profile/Cookie import is intentionally not implemented yet; normal Spaces share the UFO-Browser profile partition.
- UFO-Browser adds bounded Overview renderer, preview-cache, and GPU cadence controls outside the CLI helper contract.
