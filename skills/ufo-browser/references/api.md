# UFO-Browser Agent API

## Contents

- [Facades](#facades)
- [Task Space lifecycle](#task-space-lifecycle)
- [Host bindings](#host-bindings)
- [Stable errors](#stable-errors)

## Facades

The installed Ego-compatible Skill flat API is also first-class. Existing scripts can call
`useOrCreateTaskSpace`, `openOrReuseTab`, `snapshotText`, `fillInput`,
`pressKey`, `click`, `doubleClick`, `hover`, `scrollBy`, `js`, `cdp`,
`captureScreenshot`, `wait`, and `cliLog` without rewriting them to facades.
Legacy `timeout`, `settle`, and `wait` values are interpreted as seconds.

`page` provides navigation, locators, input, waits, evaluation, screenshots, snapshots, downloads, and page information.

`browser` provides tab listing, selection, creation/reuse, closing, iframe target lookup, and real-tab selection.

`taskSpaces` provides `list`, `switch`, `new`, `useOrCreate`, `claim`, `complete`, `handOff`, `takeOver`, and `waitForAgentControl`.

`site` provides optional learned site tools. `fetch.server` issues Node-side requests; `fetch.browser` issues requests from the active browser page. `cdp` sends a raw protocol command.

The installed flat host aliases also include `createTab`, `getBrowserVersion`,
`listProfiles`, `markTaskSpaceError`, `sendCDPMessage`,
`setAgentTaskState`, `animationHighlightMouseToPosition`, and `iframeTarget`.
They are non-enumerable globals, matching the audited Ego 0.4.5.9 runtime;
Node's callable `fetch` keeps its original enumerable property.

`getBrowserVersion()` resolves to
`{ currentVersion: string, updateAvailable: boolean }`. `listProfiles()`
resolves to `{ profiles: [{ id, isDefault, name }] }`. `createTab(url)` requires
a string URL and resolves to `{ targetId }`.

## Task Space lifecycle

Spaces persist metadata and page sessions across CLI processes. Ownership and the active socket lease are separate:

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
snapshot                    createTaskSpace
claimTaskSpace              closeTaskSpace
useTaskSpace                animationHighlightMouseToPosition
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
EGO_TASK_HOST_DISCONNECTED
EGO_TASK_SPACE_INACTIVE
EGO_TASK_SPACE_NOT_FOUND
EGO_TASK_SPACE_NOT_SELECTED
EGO_TASK_SPACE_UNAVAILABLE
EGO_TASK_SPACE_USER_IN_CONTROL
EGO_WEB_CONTENTS_UNAVAILABLE
```

Treat `EGO_TASK_SPACE_USER_IN_CONTROL` and `EGO_TASK_SPACE_INACTIVE` as hard stops. Surface the state to the user and wait for explicit direction.
