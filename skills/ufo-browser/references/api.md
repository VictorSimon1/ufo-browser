# UFO-Browser Agent API

## Contents

- [Facades](#facades)
- [Task Space lifecycle](#task-space-lifecycle)
- [Host bindings](#host-bindings)
- [Snapshot V2](#snapshot-v2)
- [Workflow recorder and replay](#workflow-recorder-and-replay)
- [Assertions and events](#assertions-and-events)
- [Actionability and timeout errors](#actionability-and-timeout-errors)
- [Request routing](#request-routing)
- [Storage state](#storage-state)
- [Tracing](#tracing)
- [Stable errors](#stable-errors)

## Facades

The installed UFO-Browser flat API is first-class. Scripts can call
`bootstrapTaskSpace`, `useTaskSpace`, `openOrReuseTab`, `snapshotText`, `fillInput`,
`pressKey`, `click`, `doubleClick`, `hover`, `scrollBy`, `js`, `cdp`,
`captureScreenshot`, `wait`, and `cliLog` without rewriting them to facades.
Legacy `timeout`, `settle`, and `wait` values are interpreted as seconds.

`page` provides navigation, locators, input, waits, evaluation, screenshots, snapshots, downloads, and page information.

It also provides:

- `frameLocator(selector)` for same-process, nested, and cross-origin iframe actions.
- `on`, `off`, `once`, and `waitForEvent` for console, page exceptions, network requests, failures, new tabs, and downloads.
- `route`, `unroute`, and `unrouteAll` for request interception.
- `storageState` and `setStorageState` for selected-profile Cookie state and origin storage.
- `tracing.start` and `tracing.stop` for Chromium performance traces.

`browser` provides tab listing, selection, creation/reuse, closing, iframe target lookup, and real-tab selection.

`taskSpaces` provides `list`, `bootstrap`, `use`, `claim`, `complete`, `handOff`, `takeOver`, and `waitForAgentControl`. `bootstrap({ name, profileId?, url? })` always creates and verifies a fresh Space. `use(id)` accepts only an existing numeric Space ID and never creates, guesses by name, or changes Profile/Session. UFO extensions `taskSpaces.events.list`, `taskSpaces.trace.list`, and `taskSpaces.trace.export` expose the selected Space's bounded local diagnostic timeline.

`site` provides optional learned site tools. `fetch.server` issues Node-side requests; `fetch.browser` issues requests from the active browser page. `cdp` sends a raw protocol command.

`workflows` records successful traced actions as versioned local Recipes and
replays them deterministically without an embedded LLM. `secret(value)` creates
an in-memory value for a Recipe secret slot; its value is never written to the
Workflow store.

The global `expect(target)` helper provides auto-retrying locator/page assertions.

The installed flat host aliases also include `createTab`, `getBrowserVersion`,
`listProfiles`, `markTaskSpaceError`, `sendCDPMessage`,
`setAgentTaskState`, `animationHighlightMouseToPosition`, and `iframeTarget`.
They are non-enumerable globals, matching the audited Ego 0.4.6.12 runtime;
Node's callable `fetch` keeps its original enumerable property.

`getBrowserVersion()` resolves to
`{ currentVersion: string, updateAvailable: boolean }`. `listProfiles()`
resolves to `{ profiles: [{ id, isDefault, name }] }`, including the built-in
`{ id: 'Temporary', isDefault: false, name: '临时 Profile' }` template.
`bootstrapTaskSpace({ name, profileId?, url? })` returns a verified Space record
with its active tab URL. `createTab(url)` requires
a string URL and resolves to `{ targetId }`.

## Task Space lifecycle

Spaces persist metadata and page sessions across CLI processes. Ownership and the active socket lease are separate:

- Persistent Profile Spaces are saved and reuse that Profile's `persist:*` Session.
- Temporary Profile Spaces use a unique non-persistent Session per Space, clear it on close, and never enter restart state.

- `ownership=agent` allows the selected connection to acquire a lease.
- `ownership=agentDelegatedToUser` preserves Agent ownership while manual control is delegated.
- `ownership=user` rejects Agent page commands until the user explicitly authorizes claim or takeover.
- `lifecycle=completed|error` rejects further page commands until an explicit takeover reactivates the task.

One connection holds at most one Space lease. A Space lease contains a generation; every mutation and CDP send checks that generation so expired commands cannot run.

## Host bindings

The UFO-Browser-owned runtime talks to these App host methods over newline-delimited JSON on a current-user-only Unix socket:

```text
createTab                   listTabs
listTaskSpaces              listProfiles
snapshot                    resolveRef
bootstrapTaskSpace          claimTaskSpace
closeTaskSpace              useTaskSpace
animationHighlightMouseToPosition
handOffTaskSpace            takeOverTaskSpace
completeTaskSpace           markTaskSpaceError
setAgentTaskState           getBrowserVersion
listSpaceEvents             listAgentTrace
exportAgentTrace
startWorkflowRecording      finishWorkflowRecording
cancelWorkflowRecording     listWorkflows
getWorkflow                 prepareWorkflowReplay
finishWorkflowReplay
sendCDPMessage
onCDPMessage                onSendCDPMessageError
```

CDP page sessions are synthetic. `Target.attachToTarget({ flatten: true })` returns a UFO-Browser session id that routes commands to the selected Space and tab's in-process Electron debugger.

Cross-site iframe targets are scoped to the selected page using frame-owner DOM
ids. Attaching one returns another synthetic session that forwards commands to
the real Chromium OOPIF session without exposing targets from other Spaces.

`snapshotText()` also reads each scoped OOPIF accessibility tree. Child refs
retain their `frameId`; the bundled resolver attaches that target on demand and
routes element resolution, handle operations, and trusted input through the
child session. Public refs remain numeric and collision-safe even when renderer
processes reuse the same backend DOM node id.

Snapshot refs retain a unique stable locator when one exists. After navigation
or DOM replacement, ref-based operations refresh the snapshot internally and
recover through that locator. Recovery rejects missing or ambiguous matches
rather than selecting a different element. Snapshot text emits `loc=...` only
when the locator is unique and executable from the root page context.

The App also retains a bounded in-memory ref history per live tab. A fresh CLI
process can therefore reuse an old `@N` from a previous heredoc. Recovery first
uses the saved stable locator, then falls back to an exact role/name match, and
only succeeds for one current element. The history does not survive an App or
tab restart.

## Snapshot V2

`snapshotText(options)` remains the Ego-compatible text API. `snapshotRaw(options)`
returns the structured result. The facade form
`page.snapshot({ format: 'structured', ...options })` is equivalent:

```js
const initial = await snapshotRaw({
  interactive: true,
  compact: true,
  selector: '#register-form',
  depth: 6,
  urls: true,
  boxes: true,
})

const next = await snapshotRaw({
  interactive: true,
  compact: true,
  selector: '#register-form',
  depth: 6,
  urls: true,
  boxes: true,
  sinceRevision: initial.revision,
})
```

The result is `{ content, refs, revision, kind, baseRevision?, fallbackReason?,
changes? }`. A compatible baseline returns `kind: 'delta'` with changed, added,
and removed lines. Navigation/document replacement, an evicted baseline, an
oversized change set, or incomplete iframe coverage returns a safe full result
and an explicit `fallbackReason`; replay code must not treat fallback as a
delta. Use the exact same filtering options on both calls.

Refs use backend DOM identity, so the same node keeps its ref across full,
compact, interactive, selector, depth, URL, box, and viewport views. OOPIF refs
use deterministic collision-safe public ids. `scope: 'only_within_viewport'`
uses CDP layout snapshots, `selector` uses CDP DOM queries, and `boxes` uses
bounded `DOM.getBoxModel` calls; none execute arbitrary page JavaScript. The
revision cache is tab-local, memory-only, bounded to 12 view revisions, and is
cleared with the WebContents/App lifecycle. Selector roots and box lookups each
have an explicit 2,000-node limit rather than silently doing unbounded work.
Sensitive URL credentials/query parameters are redacted, and Snapshot delta
text applies the same password/OTP/Token pattern redaction as Agent diagnostics.

## Workflow recorder and replay

Recording is explicit. Start it immediately before the reusable part of a
successful flow, use normal flat helpers or `page` locators, then finish in the
same heredoc:

```js
const recording = await workflows.start('register-account')

await page.getByLabel('Email').fill('recording@example.com')
await page.getByLabel('Password').fill('recording-only-secret')
await page.getByRole('button', { name: 'Continue' }).click()

const recipe = await recording.finish({
  variables: ['email'],
  secrets: ['password'],
})
```

The compiler correlates successful Trace steps, records stable locator and
role/name/label/parent semantics, explicit `nth` metadata, URL preconditions,
post-step assertions, and observed navigation, Popup, Dialog, and Download
waits. Form values become variables or secret slots before persistence. It
does not save a coordinate macro and rejects unsupported or ambiguous actions.
Recipes are independent of the source Space, retain bounded versions, and
store per-version success/failure statistics. Learned `site.runTool` and
`site.runBrowserTool` calls can be Recipe steps; they remain owned by the
existing learned-site-tool subsystem.

Replay requires every variable and requires `secret(...)` for every secret:

```js
const result = await workflows.replay('register-account', {
  email: 'new@example.com',
  password: secret('new-password'),
})
```

Target recovery is finite: original locator, unique role/name, unique
label/parent semantics, then the existing unique locator self-heal. A missing
or multiple target stops replay; UFO never chooses the first candidate. The
returned failure package contains the failed step, expected target, candidate
counts, Snapshot delta, relevant journal events, and a screenshot path when
capture succeeds.

Each target step also stores a bounded Action Cache entry containing only the
last successful locator strategy and locator already permitted by the Recipe.
Replay tries that entry first. Missing, non-unique, or hidden cached targets are
invalidated before any action is dispatched, then the normal finite recovery
chain runs once. A successful fallback replaces the entry atomically. Replay
results and Recipe statistics expose `hits`, `misses`, `fallbacks`, and
`updates`; input values and secrets are never cached. Pass
`{ actionCache: false }` only when comparing the uncached diagnostic path.

Payment, send, publish, delete, booking, account mutation, and other high-risk
final actions return `waitingApproval` by default. Authorization must be
explicitly scoped to both domain and action:

```js
await workflows.replay('publish-post', inputs, {
  approval: {
    highRisk: true,
    domains: ['example.com'],
    actions: ['click'],
  },
})
```

Inspect saved definitions with `await workflows.list()` and
`await workflows.get(name, version?)`. Active recording data is memory-only and
is discarded when its CLI connection closes; saved Recipes survive App and
Space restarts.

## Assertions and events

Assertions retry until they pass or the timeout expires:

```js
await expect(page.locator('#status')).toHaveText('Success', { timeout: 3000 })
await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled()
await expect(page.getByRole('dialog')).toBeVisible()
await expect(page.locator('tbody tr')).toHaveCount(10)
await expect(page).toHaveURL(/dashboard/)
await expect(page.locator('#email')).toHaveValue('agent@example.com')
await expect(page.locator('.error')).not.toBeVisible()
```

`page.on/off/once` and `page.waitForEvent` support `console`, `pageerror`,
`request`, and `requestfailed`. Listeners live only for the current CLI process.

For events that already happened, use the App-owned Space journal:

```js
const result = await taskSpaces.events.list(task.id, {
  after: lastSequence,
  categories: ['action', 'network', 'console', 'lifecycle'],
  limit: 200,
})
cliLog(result.events)
lastSequence = result.nextSequence

const failures = await taskSpaces.trace.list(task.id, {
  after: 0,
  status: 'failed',
  limit: 50,
})

await taskSpaces.trace.export(task.id, {
  path: '/absolute/path/agent-trace.zip',
  format: 'zip', // 'markdown' | 'json' | 'zip'
})
```

Sequences are monotonic across App restarts while retained. If bounded history
has already evicted the requested cursor, `cursorExpired` is true. The journal
stores no response bodies and redacts passwords, OTPs, Cookies, Authorization,
Tokens, credentials, and sensitive URL query parameters before memory or disk
storage. Temporary Space history is removed when that Space closes.
ZIP exports contain both redacted text formats and up to 20 referenced failure
screenshots. Screenshot files must be regular PNG, JPEG, or WebP files no larger
than 10 MB each; missing, symbolic-link, and oversized files are skipped.

```js
page.on('console', message => cliLog(message.type() + ' ' + message.text()))
page.on('pageerror', error => cliLog(error.message))

const failed = await page.waitForEvent(
  'requestfailed',
  request => request.url().includes('/api/orders'),
  { timeout: 3000 },
)
cliLog(failed.failure())
```

Console messages expose `type()`, `text()`, `args()`, and `location()`.
Requests expose `url()`, `method()`, `headers()`, `postData()`,
`resourceType()`, and `failure()`.

## Actionability and timeout errors

Normal locator clicks wait for the target to exist, be visible, enabled,
stable, and able to receive pointer events. A failed click throws
`ActionabilityError` with `locator`, `reason`, `interceptedBy`, `attempts`,
`recovery` suggestions,
`callLog`, and, when capture succeeds, `screenshot`.

`locator.click({ trial: true })` performs the checks without clicking.
`locator.click({ force: true })` intentionally bypasses normal hit-testing and
should be reserved for pages where that behavior is explicitly required.

`page.waitForSelector` throws `TimeoutError` by default. Use
`{ returnFalseOnTimeout: true }` only when timeout-as-false is deliberate. The
flat Ego-compatible `waitForElement` helper retains its boolean timeout result.

## Request routing

`page.route(matcher, handler, { times? })` accepts an exact URL/glob string,
`RegExp`, or synchronous predicate receiving a `URL`. Newer matching handlers
run first. The handler receives:

```text
route.continue({ url?, method?, postData?, headers? })
route.fulfill({ status?, statusText?, headers?, contentType?, body?, json? })
route.abort(errorCode?)
route.request()

request.url()              request.method()
request.headers()          request.postData()
request.resourceType()     request.isNavigationRequest()
```

If the handler returns without resolving the route, UFO continues the request.
`page.unroute(matcher, handler?)` removes matching handlers;
`page.unrouteAll()` disables routing for the current page session.

## Storage state

`page.storageState({ path? })` returns `{ cookies, origins }`. Cookies cover the
selected UFO profile's Cookie store; `origins` contains localStorage for the
current page origin only. Passing `path` also writes the JSON result.

`page.setStorageState(stateOrPath, { clear? })` restores a returned object or
JSON file. With `clear: true`, it clears existing profile cookies and clears
each restored origin before applying entries. The JSON is unencrypted and can
contain active credentials. This API does not read or decrypt a local Chrome
profile.

## Tracing

`page.tracing.start({ categories?, screenshots?, traceConfig?,
bufferUsageReportingInterval? })` starts one trace for the active page session.
`page.tracing.stop({ path?, timeout? })` ends it and returns the output path.
The output is Chromium JSON readable by Chrome Trace Viewer and Perfetto;
`timeout` is milliseconds and `0` disables the stop timeout.

## Stable errors

```text
EGO_BROWSER_UNAVAILABLE
EGO_CDP_CHANNEL_UNAVAILABLE
EGO_CDP_SEND_FAILED
EGO_INVALID_ARGUMENT
EGO_INVALID_RESULT_PAYLOAD
EGO_OPERATION_FAILED
EGO_RESULT_CONVERSION_FAILED
EGO_SNAPSHOT_FAILED
EGO_STALE_REF_AMBIGUOUS
EGO_TASK_HOST_DISCONNECTED
EGO_TASK_SPACE_INACTIVE
EGO_TASK_SPACE_NOT_FOUND
EGO_TASK_SPACE_NOT_SELECTED
EGO_TASK_SPACE_UNAVAILABLE
EGO_TASK_SPACE_USER_IN_CONTROL
EGO_WEB_CONTENTS_UNAVAILABLE
```

Treat `EGO_TASK_SPACE_USER_IN_CONTROL` and `EGO_TASK_SPACE_INACTIVE` as hard stops. Surface the state to the user and wait for explicit direction.
