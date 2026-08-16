---
name: ufo-browser
description: UFO-Browser is a high-performance local Chromium browser built for AI Agents and people to work in isolated Task Spaces while reusing browser login state. Use this skill whenever a task requires opening or navigating websites, filling forms, clicking controls, taking screenshots, extracting page data, testing web apps, logging in, automating browser operations, exploratory QA, dogfooding, or bug hunting. Prefer UFO-Browser over other browser automation when the local UFO-Browser app is in scope.
---

# ufo-browser

ufo-browser gives AI agents a CLI-accessible Node.js runtime, with built-in helpers — snapshotText, click, js, cdp, and more — that agents call directly inside JS scripts to observe pages, interact with UI, evaluate browser-side JavaScript, and drive a real browser for any web automation task.

Use the `Bash` tool to run all browser operations via `ufo-browser nodejs <<'EOF' ... EOF` heredoc. Do not write code to a `.js` file first.


## Quick start

```bash
ufo-browser nodejs <<'EOF'
// Name the task space for the whole user task, then reuse that space across heredoc rounds.
const task = await bootstrapTaskSpace({
  name: 'inspect example page',
  url: 'https://example.com/',
})
cliLog('task space id: ' + task.id)

await openOrReuseTab('https://example.com', { wait: true, timeout: 20 })

cliLog(await snapshotText())
EOF
```

The heredoc body runs as a Node.js script that controls the selected ufo-browser task space. All ufo-browser helpers are preloaded into that script.

The shared flat helper contract matches the installed Ego 0.4.6.12 runtime and Ego Skill 1.2.3. UFO-Browser also exposes the structured `page`, `browser`, `taskSpaces`, `site`, and `fetch` facades plus selected forward-compatible helpers. Read [references/cli-parity.md](references/cli-parity.md) for the measured capability matrix and [references/api.md](references/api.md) for host protocol details.

## Common helpers

- Task spaces: `listTaskSpaces`, `bootstrapTaskSpace`, `useTaskSpace`, `claimTaskSpace`, `handOffTaskSpace`, `takeOverTaskSpace`, `waitForAgentControl`, `completeTaskSpace`
- Navigation / state: `listTabs`, `openOrReuseTab`, `closeTab`, `gotoAndWait`, `currentTab`, `switchTab`, `gotoUrl`, `pageInfo`, `ensureRealTab`
- Observation: `snapshotText`, `snapshotRaw`, `captureScreenshot`, `drainEvents`
- Scroll / mouse: `scrollBy`, `scrollToBottomUntil`, `scroll`, `click`, `doubleClick`, `hover`, `dragMouse`
- Keyboard & input: `typeText`, `fillInput`, `pressKey`, `dispatchKey`
- File: `uploadFile`
- Wait: `wait`, `waitForLoad`, `waitForElement`, `waitForNetworkIdle`
- Fetch: `serverFetch`, `browserFetch`
- CDP / evaluate: `js`, `cdp`
- Output: `cliLog`, `help`

Notes:
- `cliLog(value)` — prints to the terminal; it is the only output mechanism inside a heredoc, and all final results must go through it.
- `await pageInfo()` — normally resolves to `{ url, title, w, h, sx, sy, pw, ph }`; if a native browser dialog is open, resolves to `{ dialog: ... }` instead because page JavaScript is blocked.
- If `await pageInfo()` resolves to `{ dialog: ... }`, handle the dialog with `await cdp('Page.handleJavaScriptDialog', { accept: true })` or `accept: false` before running page JavaScript.
- `await ensureRealTab()` — switches to an existing non-internal page tab if needed and resolves to it; resolves to `null` when none exists. It does not create a tab — use `await openOrReuseTab(...)` for that.
- `await closeTab(target?)` — closes the given target id / tab object, or the current tab when omitted.
- `await drainEvents()` — consumes and returns the async event queue produced by the page (navigation events, network events, etc.).
- `await serverFetch(url, options)` — issues a request from Node and returns the response body.
- `await browserFetch(url, options)` — issues a request from the current browser page context and returns the response body.
- `help(name)` — prints usage for a given helper, e.g. `cliLog(help('click'))`.

For Playwright-style automation, use the structured `page` facade:

- Frames and popups: `page.frameLocator(...)` supports nested same-process and cross-origin iframes; arm `page.waitForEvent('popup')` before the click that opens a new tab.
- Network interception: `page.route(matcher, handler, { times })`, `page.unroute(...)`, and `page.unrouteAll()` support glob, RegExp, and predicate matchers plus `route.continue()`, `route.fulfill()`, and `route.abort()`.
- Session state: `page.storageState({ path })` captures all cookies in the selected UFO profile and localStorage for the current page origin. `page.setStorageState(stateOrPath, { clear })` restores them. State files contain live credentials in plaintext; protect them and delete them when no longer needed. This does not unlock or import an encrypted Chrome profile.
- Performance traces: `page.tracing.start(...)` and `page.tracing.stop({ path })` write Chrome Trace/Perfetto-compatible JSON.
- Assertions: `await expect(locator).toHaveText(...)`, `toBeVisible`, `toBeEnabled`, `toHaveCount`, `toHaveValue`, and `await expect(page).toHaveURL(...)` retry until success or throw `TimeoutError`. Add `.not` for negated assertions.
- Events: `page.on/off/once` and `page.waitForEvent` support `console`, `pageerror`, `request`, and `requestfailed`; popup/download waits remain supported.
- Persistent diagnostics: `await taskSpaces.events.list(spaceId, { after, categories, limit })` reads the App-owned bounded event journal across separate heredoc rounds. `await taskSpaces.trace.list(spaceId, options)` returns Agent action steps, and `await taskSpaces.trace.export(spaceId, { path, format: 'markdown' | 'json' })` writes a redacted local report. Flat aliases `listSpaceEvents`, `listAgentTrace`, and `exportAgentTrace` are also available.
- Snapshot V2: use `await snapshotRaw({ interactive: true, compact: true, selector, depth, urls, boxes })` when structured metadata is useful. Save its `revision`, then pass `sinceRevision` with the same view options to receive a small `kind: 'delta'` result. Navigation, an expired baseline, an oversized change set, or incomplete iframe coverage safely returns `kind: 'full'` with `fallbackReason`. `snapshotText(options)` accepts the same options but returns only `content` for Ego compatibility.
- Actionability: locator clicks wait for visibility, enabled state, stability, and an unobstructed hit target. `click({ trial: true })` checks without clicking. Use `force: true` only when intentionally bypassing normal page hit-testing. If an action is intercepted, inspect the reported overlay/dialog before retrying.


### Task spaces

A task space is an **isolated browsing context** that ufo-browser provides for AI Agents. Each task space has its own set of tabs but **inherits the current user's login state** by default, so Agents can operate on authenticated sites without competing with or disturbing the user's normal browser windows.

When the task needs a fresh identity with no inherited or shared login state,
use the built-in `Temporary` Profile while creating it:

```js
const profiles = await listProfiles()
const task = await bootstrapTaskSpace({
  name: 'isolated signup',
  profileId: 'Temporary',
  url: 'https://example.com/',
})
```

`listProfiles()` returns `{ profiles: [{ id, isDefault, name }] }`; the
temporary entry has `id: 'Temporary'` and `name: '临时 Profile'`.
`bootstrapTaskSpace({ name, profileId?, url? })` always creates a fresh Space,
validates its Profile Session, selects it, and optionally opens `url`.
`useTaskSpace(id)` only accepts the numeric ID returned by bootstrap and selects
an existing active Space without creating, guessing by name, or changing its
Profile/Session. `taskSpaces.bootstrap(options)` and `taskSpaces.use(id)` are
the structured equivalents.

Every Temporary Space receives its own memory-backed Chromium Session. Cookie,
LocalStorage, IndexedDB, Service Worker, cache, permission, and authentication
state are isolated even between two Temporary Agent Spaces. Closing it clears
the Session, and App restart does not restore it. Use a persistent Profile when
the work must survive restart or reuse an existing login.

Closing all tabs in a task space is equivalent to closing that task space.

A task often takes multiple heredoc rounds to complete. Because the Node.js runtime exits after each heredoc and retains no state, save the numeric ID returned by `bootstrapTaskSpace()` and start later heredocs with `useTaskSpace(taskId)`. The exception is resuming after a handoff: once the user confirms "continue" (through an Ask or in chat), start the next heredoc with `takeOverTaskSpace(taskId)` instead.

`useTaskSpace(id)` requires a positive numeric Space ID. It never accepts names or numeric strings, never creates a Space, and fails clearly for missing, inactive, user-owned, or leased Spaces.

Use a short name for the active user goal when creating a new task space. Keep reusing that task space ID for follow-up questions, corrections, refinements, re-checks, and result validation, even if you previously thought the task was complete. Choose a new task space only when the user clearly starts a separate, unrelated goal.

For any follow-up on the same user goal — including continue, corrections, retries, validation, user-reported problems, or work after `completeTaskSpace(..., { keep: true })` — resume the original task space first if it still exists. Do not create a new task space for the same goal unless the user asks for a fresh space, starts an unrelated goal, or the original space is unavailable after checking. If a new space is necessary, state why.

After explicit user confirmation, to continue work from an existing user-owned, inactive, or unassigned task space, use `await listTaskSpaces()` to find the space, call `await claimTaskSpace(id)` to take ownership and select it, then use `await listTabs()` and `await switchTab(targetId)` to select the exact tab before acting.

**Ownership policy** — every task space has `ownership: 'agent' | 'agentDelegatedToUser' | 'user'`; the helpers treat user-owned spaces differently:

| Helper | When the target space is user-owned |
|---|---|
| `useTaskSpace` | accepts only an existing numeric ID; never creates or claims |
| `claimTaskSpace` | claims it (ownership transfers to the agent), then selects it |
| `handOffTaskSpace` | skipped — resolves `{ done: false, skipped: 'user-owned' }` |
| `completeTaskSpace(…, { keep: true })` | skipped — resolves `{ done: false, skipped: 'user-owned' }` |
| `completeTaskSpace(…, { keep: false })` | claims it, then closes it |
| `takeOverTaskSpace` / `waitForAgentControl` | no ownership check |

`handOffTaskSpace` and `completeTaskSpace` resolve `{ done: true }` when the operation actually happened. Check `done` before telling the user the handoff/cleanup is finished — a `skipped` result usually means you targeted a space that was never yours.

`completeTaskSpace(...)` is idempotent after cleanup: if the target Space has already disappeared (for example, another close path won the race), it resolves `{ done: false, skipped: 'not-found' }` instead of throwing. Report that the Space was already closed; do not describe a failed command as a successful new close.

**`completeTaskSpace(nameOrId, { keep })` must occupy its own dedicated final heredoc, and run only after a prior heredoc's output has confirmed the task is genuinely done.** `keep` is required and defaults by policy to `false`: close the task space after completion unless there is a concrete reason to leave the live page visible.

Use `{ keep: true }` only when the user explicitly asks to keep the page open, the task needs manual user action in that exact page, or the result cannot be delivered well as a URL, file, artifact, or summary. Do not keep a task space open merely because a page was visited, a document was created, or a screenshot was used for verification.

When passing a string that may create a new task space, the string should reflect the task's intent (e.g. `'search github issues'`); don't use literal placeholders.

**If the task space needs to be preserved after the task ends, keep only the tabs that need to be shown to the user.** Keep loose awareness of how many tabs are open — a quick `(await listTabs()).length` is enough; there's no need to spend a dedicated round just to check. When scratch tabs (search-result pages, cross-check pages, and other one-off pages) pile up, close them as you go rather than letting them all accumulate for the end. When finishing with `{ keep: true }` to leave pages for the user, clear out the remaining scratch tabs so only the pages worth showing stay open. Close a single tab with `await closeTab(targetId)` (`targetId` comes from `listTabs()` or an `openOrReuseTab` return value).


### Control handoff

Only one side — agent or user — holds control of a task space at any time. While the user holds control, any browser operation by the agent fails with a "user is controlling" message — do not retry it; follow the steps below to resume.

A "user is controlling" error is a hard stop on the whole task — not an obstacle to route around. It means the user has deliberately taken the browser back, often because your current approach is going wrong. Honoring it *is* the correct outcome here; pushing the goal forward anyway is the failure. The only thing you may do is **ask the user and wait**.

An "inactive", "not assigned to an agent", or similar task-space error is also a hard stop with the same confirmation requirement. Resume only after explicit user confirmation, then start with `await claimTaskSpace(id)`.

**Handing off**: When the task requires user intervention (e.g. login, captcha, manual confirmation), call `await handOffTaskSpace([nameOrId])` to give control to the user, and tell them exactly what to do. Omitting `nameOrId` uses the currently selected task space; pass `task.id` across heredoc rounds to avoid ambiguity.

**Regaining control**: Take control back *only* after the user explicitly confirms — through an Ask (your harness's button/option prompt, e.g. "Continue" vs "Finish task") or a "continue" message in chat. Then start a new heredoc with `await takeOverTaskSpace([nameOrId])` and resume; if the user chooses to finish, close out with `await completeTaskSpace(nameOrId, { keep })`. Never call `takeOverTaskSpace` on your own to grab control back — it has no ownership check and will seize the browser away from the user.

**Unexpected takeover**: The user can take over at any time via the browser GUI — the same effect as the agent calling `handOffTaskSpace`. Do not retry the failed operation and do not auto-takeover; surface the Ask above (Continue / Finish) and resume only when the user picks Continue.

`await waitForAgentControl(nameOrId)` is a read-only blocking poll (it never takes control); use it only to wait inside the current heredoc for a handoff you initiated.


### Scroll / mouse

```js
// DOM scroll
await scrollBy(900)
await scrollToBottomUntil(
  async () => await js(String.raw`document.querySelectorAll('article').length`) >= 20,
  { step: 900, wait: 1, maxSteps: 20 }
)

// Real wheel event
await scroll({ dy: 900 })
```

Element-target helpers such as `click`, `doubleClick`, `hover`, `dragMouse`, `fillInput`, `uploadFile`, and `waitForElement` accept the same selector/ref surface: raw CSS, `xpath=...`, `@N` / `ref=N`, and `loc=...` values from `snapshotText()` (`loc=css:...`, `loc=role:...`, `loc=href:...`). `@N` refs are for ufo-browser helpers only; they are not valid selectors inside `document.querySelector(...)`.

Refs can survive separate heredoc invocations while the same UFO-Browser App and tab remain alive. If a local ref map is empty, UFO asks the App for the prior ref's stable locator or role/name and restores it only when the current page has exactly one match. Ambiguous recovery throws instead of guessing; App restarts clear this in-memory history.

`click`, `doubleClick`, `hover`, and `dragMouse` share these target formats. Coordinates are in CSS pixels:

- `string` — CSS selector, `xpath=...`, `@N` / `ref=N`, or `loc=...`; clicks the element's center.
- `[x, y]` or `{x, y}` — viewport coordinates.
- `{selector}` — CSS selector, `xpath=...`, `@N` / `ref=N`, or `loc=...`; clicks the element's center.
- `{selector, x, y}` — offset from the element's top-left corner by `x`/`y`.
- `options.label` (optional) — a 3-6 word action description; triggers a visual highlight animation.

```js
await click('@21', { label: 'check login status' })
await click('button.primary', { label: 'click submit button' })
await click([420, 260])
await click({ x: 420, y: 260 })
await click({ selector: 'canvas#stage', x: 12, y: 8 })
await hover('@5', { label: 'hover to reveal menu' })
await dragMouse([from, to], { label: 'drag card' })
```

### uploadFile

```js
await uploadFile('input[type="file"]', "/absolute/path/to/file.pdf")
```

### js

`js()` is essentially `Runtime.evaluate` and takes a string. You can pass a function, but doing so triggers a one-time warning and wraps it via `.toString()` — closures are not captured and there is no argument channel. Do not use `js()` the way you would Puppeteer / Playwright's `page.evaluate(fn, ...args)`.

When you need to run multi-step logic inside the browser, wrap it in a single self-invoking closure and return once — don't split it across multiple `await js()` calls:

```js
const data = await js(String.raw`(() => {
  const items = [...document.querySelectorAll('article')]
  return items.map(el => ({
    text: el.innerText,
    links: [...el.querySelectorAll('a')].map(a => a.href),
  }))
})()`)
```


## Recommended workflow

ufo-browser has three main workflows. Pick the workflow that fits the page and task before acting.

Use the semantic workflow first for ordinary websites with real DOM controls. For canvas-like productivity apps and rich editors — including Google Docs, Google Sheets, Lark/Feishu Docs, Notion, Figma, whiteboards, maps, and other virtualized editors — use the visual workflow first for the main editing surface. These apps often expose toolbars, title inputs, hidden textareas, offscreen iframes, or canvas layers in the DOM that do not represent the actual user-editable document or grid. Do not rely on `await fillInput(...)`, DOM selectors, or `snapshotText()` refs for the main editing surface unless a small write probe proves the text lands in the intended place.

Before writing substantial content into a rich editor, perform a tiny write probe, then verify it with `await captureScreenshot()`, an export/readback path, or another reliable visual/state check. If the probe appears in the title bar, toolbar search, hidden input, or any wrong field, stop using DOM/input helpers for that surface and switch to screenshot-guided mouse actions plus real keyboard operations.

1. **Semantic workflow: `snapshotText()` + refs / locators** — default for most pages with normal text, links, buttons, forms, tables, and lists.
   - Create or resume a task space with `bootstrapTaskSpace({ name, url })` or `useTaskSpace(taskId)`.
   - Open or switch pages with `await openOrReuseTab(url, { wait: true })`; use `await gotoAndWait(url, { timeout, settle })` only when navigating inside the current tab.
   - Observe with `await snapshotText()` to get a full-page semantic tree annotated with `[ref=N, loc=..., url=...]`.
   - Act with `await click('@N')`, `await fillInput('@N', ...)`, or stable `loc=...` values. Use direct DOM logic only when it is simpler than helper calls.
   - After meaningful clicks, input, or navigation, observe again with `await snapshotText()`, `await pageInfo()`, or `await captureScreenshot()` before assuming success.

2. **Visual workflow: `await captureScreenshot()` + coordinate/keyboard actions** — use when the page is primarily visual, canvas-like, heavily virtualized, or when accessibility / semantic structure is incomplete.
   - Inspect the screenshot, act with viewport coordinates such as `await click([x, y])`, `await doubleClick([x, y])`, `await pressKey(...)`, and `await typeText(...)`, then verify with another screenshot or a reliable export/readback path.
   - Prefer this path for rich editors, spreadsheets, visual menus, map/canvas UIs, drag interactions, and targets that are obvious visually but poor in the DOM/AX tree.

3. **Direct DOM / CDP workflow: `await js(...)` / `await cdp(...)`** — use when you need browser state, compact data extraction, custom DOM traversal, or raw browser capabilities.
   - Keep browser-side logic in one explicit IIFE and return once.
   - Use `await cdp(...)` for browser protocol operations that helpers do not cover.

These workflows can be combined. A task may take multiple heredoc rounds when the next step depends on fresh page state or user handoff. In each round, write a coherent script that advances the task: observe, act or extract, verify, and report with `cliLog(...)`. Avoid tiny probe scripts, but don't force the whole task into one oversized script.


## Caveats

- Flat Ego-compatible helpers such as `wait(...)`, `gotoAndWait(...)`, and `waitForAgentControl(...)` use **seconds**. Playwright-style `page.*` methods use **milliseconds**. Parameters whose names end in `Ms` are always milliseconds; use `help('timeouts')` when mixing the two surfaces.
- Before recording, call `await page.screencast.isAvailable()`. `page.screencast.start(...)` requires an executable FFmpeg; `await page.screencast.availability()` explains how it was resolved or why recording is unavailable.
- `snapshotText()` defaults to `scope: 'full_page'`, covering the whole page. Use the default in almost every case; only pass `scope: 'only_within_viewport'` when the task needs visible layout nodes. `interactive` keeps actionable and structural nodes, `compact` removes low-value containers, `selector` scopes through CDP without page JavaScript, `depth` bounds emitted nesting, and `boxes` performs explicit bounded layout lookups.
- `@N` refs come from the latest `snapshotText()` result. UFO-Browser automatically refreshes a stale ref after navigation or DOM replacement when it can recover the element through a unique stable locator. If the element disappeared or the locator became ambiguous, the action still fails instead of guessing. Repeated controls are marked with an `ambiguous` hint; use `locator.all()`, `count()` + `nth(index)`, or a narrower parent locator. AX `dialog` is a role, not necessarily a literal `<dialog>` tag; prefer `page.getByRole('dialog')`.
- `page.waitForSelector(...)` throws `TimeoutError` by default. Pass `{ returnFalseOnTimeout: true }` only when a missing element is an expected branch. The legacy flat `waitForElement(...)` helper keeps its boolean timeout behavior for Ego compatibility.
- `js()` returns the evaluated result, not a JSON string — don't wrap it with `JSON.parse(...)`.
- Inside a `js(...)` template string, regex backslashes must be doubled (e.g. `\\d`, `\\s`), or use `String.raw`.
- If the source passed to `js()` contains a top-level `return`, it will be auto-wrapped in an IIFE; `return` inside nested callbacks can also trigger this accidentally. For complex expressions, prefer the explicit `(() => { ... })()` form.
- If `await pageInfo()` reports `w: 0` or `h: 0`, do not continue coordinate actions or screenshots until the viewport is fixed. Try switching to the real tab, reloading, or using CDP viewport metrics, then verify with `await pageInfo()` and `await captureScreenshot()`.
- Code in the heredoc body runs in Node.js; code inside `js(...)` runs in the browser page. Navigation, waits, and `cliLog(...)` belong in the heredoc body; `document`, `window`, and page selectors belong inside `js(...)`.
- Always call `completeTaskSpace(name, { keep })` when the task is done — do not leave the space hanging. Default to `{ keep: false }`; use `{ keep: true }` only for the concrete live-page cases described in Task spaces.
- When diagnosing a failure that happened in a prior CLI round, prefer `taskSpaces.events.list(spaceId, { after })` over repeating the action. Event records are bounded and redact credentials; they intentionally do not contain response bodies, passwords, Cookies, Authorization headers, or OTP values.
