# UFO-Browser Agent API

## Contents

- [Facades](#facades)
- [Task Space lifecycle](#task-space-lifecycle)
- [Host bindings](#host-bindings)
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

`taskSpaces` provides `list`, `bootstrap`, `use`, `claim`, `complete`, `handOff`, `takeOver`, and `waitForAgentControl`. `bootstrap({ name, profileId?, url? })` always creates and verifies a fresh Space. `use(id)` accepts only an existing numeric Space ID and never creates, guesses by name, or changes Profile/Session.

`site` provides optional learned site tools. `fetch.server` issues Node-side requests; `fetch.browser` issues requests from the active browser page. `cdp` sends a raw protocol command.

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
