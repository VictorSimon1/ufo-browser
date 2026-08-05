---
name: x-browser
description: Control the local X-Browser app through JavaScript in isolated Task Spaces. Use whenever a task requires opening or navigating websites, reading page content, filling forms, clicking controls, taking screenshots, extracting structured data, testing web apps, reusing browser login state, or running multiple browser jobs without disturbing the user's visible tabs.
---

# X-Browser

Run browser work through the bundled `x-browser` CLI. Keep each user task in one named Task Space and reuse its numeric id across command rounds.

## Quick start

```bash
x-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('inspect example page')
cliLog(`task space: ${task.id}`)

await openOrReuseTab('https://example.com', { wait: true })
cliLog(await snapshotText())
EOF
```

The heredoc body runs as one async JavaScript program. `cliLog(...)` is the ego-compatible output helper; `console.log(...)` is also supported. The App, Space, tabs, cookies, and page state outlive the short CLI process.

X-Browser exposes the same flat helper names and global-binding semantics used by the installed ego-browser Skill. User code may locally shadow a helper name (`const screenshot = ...`, for example) without a duplicate-declaration error. The newer `taskSpaces`, `browser`, and `page` facades remain available as aliases.

## Ego-compatible helpers

- Task Spaces: `listTaskSpaces`, `switchTaskSpace`, `newTaskSpace`, `useOrCreateTaskSpace`, `claimTaskSpace`, `completeTaskSpace`, `handOffTaskSpace`, `takeOverTaskSpace`, `waitForAgentControl`
- Navigation and tabs: `listTabs`, `currentTab`, `switchTab`, `openOrReuseTab`, `closeTab`, `ensureRealTab`, `gotoAndWait`, `gotoUrl`, `pageInfo`
- Observation: `snapshotText`, `snapshotRaw`, `captureScreenshot`, `elementCenter`, `drainEvents`, `textContent`, `innerText`, `inputValue`, `isChecked`, `getAttribute`, `count`, `allInnerTexts`, `allTextContents`, `evaluateAll`
- Pointer and scroll: `click`, `doubleClick`, `dblclick`, `hover`, `dragMouse`, `drag`, `scroll`, `wheel`, `scrollBy`, `scrollToBottomUntil`, `scrollIntoViewIfNeeded`
- Keyboard and forms: `typeText`, `pressSequentially`, `fillInput`, `fill`, `pressKey`, `press`, `dispatchKey`, `insertText`, `focus`, `check`, `uncheck`, `setChecked`, `selectOption`, `dispatchEvent`, `uploadFile`, `setInputFiles`
- Waits: `wait`, `waitForTimeout`, `waitForLoad`, `waitForLoadState`, `waitForElement`, `waitForSelector`, `waitForFunction`, `waitForURL`, `waitForRequest`, `waitForResponse`, `waitForNetworkIdle`
- Evaluate and network: `js`, `evaluate`, `cdp`, `serverFetch`, `browserFetch`
- Site skills: `siteSkills`, `siteSkillsForUrl`, `runSiteTool`, `runSiteBrowserTool`, `learnContext`
- Output and discovery: `cliLog`, `help`

As in ego-browser, `wait(...)` and compatibility helper options named `timeout`/`settle` use seconds; options explicitly ending in `Ms` use milliseconds. Raw Playwright-style facade methods continue to use milliseconds. `js()` returns the evaluated value directly, not a JSON string.

## Choose a workflow

1. Use `snapshotText()` first for ordinary pages with links, buttons, inputs, lists, and tables. Act with `click`, `fillInput`, refs, stable `loc=` values, or the `page` locator facade.
2. Use `captureScreenshot('/absolute/path.png')` and coordinate input when the main surface is canvas-like, virtualized, or visually meaningful but semantically weak. X-Browser also accepts `{ path, fullPage, clip }`, but the string path form matches ego-browser exactly. Verify every material action with another screenshot.
3. Use `js(...)` or `cdp(method, params)` for compact state extraction or browser features missing from the high-level facade.

After navigation or a large DOM update, take a fresh snapshot before reusing `@N` refs. Prefer stable `loc=` values or CSS selectors across rounds.

Cross-site iframes are included in `snapshotText()` as nested `iframe` sections. Their actionable controls receive ordinary numeric `@N` refs, and helpers such as `click('@N')`, `hover('@N')`, `fillInput('@N', ...)`, and `page.elementCenter('@N')` automatically route through the correct OOPIF CDP session. Dynamic security widgets may create the iframe first and expose a checkbox a moment later; wait briefly and take a fresh snapshot instead of guessing coordinates or fabricating a result.

## Task Space rules

- Call `useOrCreateTaskSpace(nameOrId)` (or `taskSpaces.useOrCreate`) at the start of each normal command round.
- Prefer the returned numeric `task.id` in later rounds.
- Use `claimTaskSpace(nameOrId)` only when the user explicitly authorizes control of a user-owned Space.
- If X-Browser reports user control or an inactive Space, stop. Do not retry or take over automatically.
- Hand control to the user with `handOffTaskSpace(id)` when login, CAPTCHA, payment confirmation, or another manual step is required.
- Resume after explicit user confirmation with `takeOverTaskSpace(id)`.

Finish in a dedicated final heredoc only after a prior command proves the browser task is done:

```bash
x-browser nodejs <<'EOF'
cliLog(await completeTaskSpace(12, { keep: false }))
EOF
```

Use `keep: false` by default. Use `keep: true` only when the user asked to keep the exact live page open or must inspect it manually.

## Interaction guidance

- Read `await page.info()` before coordinate work; background page dimensions can change with the X-Browser window layout.
- Let X-Browser dispatch pointer and keyboard input through the target page's CDP session. Do not use OS mouse/keyboard automation.
- For OOPIF controls, use the `@N` ref returned by the latest snapshot. X-Browser attaches the child target and sends trusted input in that target's local viewport coordinates.
- Handle native JavaScript dialogs through CDP before evaluating page JavaScript.
- Keep scratch tabs bounded. Close one-off research tabs before leaving a Space open for the user.
- Never place secrets in logs, screenshots, Space names, or skill learnings.

Use `help('page')`, `help('browser')`, or `help('taskSpaces')` for the live bundled helper surface. Read [references/api.md](references/api.md) when implementing or diagnosing host protocol behavior.
