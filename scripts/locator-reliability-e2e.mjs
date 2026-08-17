import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";

const root = process.cwd();
const testNamespace = "locator-reliability";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
// Five samples make the reported p95 the single slowest observation. Keep a
// strict micro-helper budget while allowing normal macOS scheduler jitter.
const microHelperP95BudgetMs = 5;
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.UFO_BROWSER_SOCKET = join(testRoot, "x-browser.sock");

let electron;
let server;
let taskId;

try {
  await mkdir(testRoot, { recursive: true });
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]);
  server = createFixtureServer();
  const port = await listen(server);
  const fixtureUrl = `http://127.0.0.1:${port}/`;
  const oopifUrl = `http://oopif.localhost:${port}/oopif`;
  const uploadPath = join(testRoot, "upload-fixture.txt");
  const storageStatePath = join(testRoot, "storage-state.json");
  const tracePath = join(testRoot, "performance-trace.json");
  await writeFile(uploadPath, "ufo upload fixture\n");

  electron = spawn(join(root, "node_modules/.bin/electron"), ["."], {
    cwd: root,
    env: { ...process.env, X_BROWSER_TEST_APP: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  electron.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
  });
  await waitForTestSocket(20_000);

  const output = await runCli(
    auditSource(fixtureUrl, oopifUrl, uploadPath, storageStatePath, tracePath),
  );
  const marker = "__UFO_LOCATOR_RELIABILITY__";
  const line = output.split(/\r?\n/).find((value) => value.startsWith(marker));
  if (!line) throw new Error(`locator audit emitted no result: ${output}\n${stderr}`);
  const audit = JSON.parse(line.slice(marker.length));
  taskId = audit.taskId;
  await writeFile(
    join(testRoot, "locator-reliability-audit.json"),
    `${JSON.stringify(audit, null, 2)}\n`,
  );

  assert.equal(audit.covered.permanentSilentSuccesses, 0, JSON.stringify(audit.covered));
  assert.equal(audit.covered.retrySuccesses, 5, JSON.stringify(audit.covered));
  assert.match(audit.covered.attempts[0].permanent.message, /#cover/);
  assert.equal(audit.covered.attempts[0].permanent.name, "ActionabilityError");
  assert.equal(audit.covered.attempts[0].permanent.interceptedBy, "#cover");
  assert.ok(audit.covered.attempts[0].permanent.attempts > 1);
  assert.equal(audit.readonly.successes, 5, JSON.stringify(audit.readonly));
  assert.equal(audit.disabled.successes, 5, JSON.stringify(audit.disabled));
  assert.equal(audit.responseBody.successes, 5, JSON.stringify(audit.responseBody));
  assert.deepEqual(audit.routing.fulfilled, { status: 201, body: { source: "route" } });
  assert.equal(audit.routing.continued.routeHeader, "yes", JSON.stringify(audit.routing));
  assert.equal(audit.routing.aborted, true, JSON.stringify(audit.routing));
  assert.equal(audit.routing.unrouted.source, "network", JSON.stringify(audit.routing));
  assert.equal(audit.storageState.localStorage, "alpha", JSON.stringify(audit.storageState));
  assert.equal(audit.storageState.cookie, "alpha", JSON.stringify(audit.storageState));
  const savedStorageState = JSON.parse(await readFile(storageStatePath, "utf8"));
  assert.equal(
    savedStorageState.origins[0].localStorage.find((entry) => entry.name === "ufo-state")?.value,
    "alpha",
  );
  assert.equal(audit.trace.path, tracePath, JSON.stringify(audit.trace));
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  assert.ok(Array.isArray(trace.traceEvents) && trace.traceEvents.length > 0);
  assert.equal(audit.roles.checkbox, true, JSON.stringify(audit.roles));
  assert.equal(audit.roles.combobox, "two", JSON.stringify(audit.roles));
  assert.equal(audit.shadow.cssClick, 1, JSON.stringify(audit.shadow));
  assert.equal(audit.frame.clicks, 1, JSON.stringify(audit.frame));
  assert.equal(audit.frame.inputValue, "frame value", JSON.stringify(audit.frame));
  assert.equal(audit.frame.buttonCount, 1, JSON.stringify(audit.frame));
  assert.equal(audit.frame.nestedClicks, 1, JSON.stringify(audit.frame));
  assert.equal(audit.frame.oopifTarget, true, JSON.stringify(audit.frame));
  assert.equal(audit.frame.oopifClicks, "1", JSON.stringify(audit.frame));
  assert.equal(audit.frame.oopifInputValue, "oopif value", JSON.stringify(audit.frame));
  assert.equal(audit.staleRef.successes, 5, JSON.stringify(audit.staleRef));
  assert.ok(audit.staleRef.maxElapsedMs < 500, JSON.stringify(audit.staleRef));
  assert.equal(audit.snapshotLocators.failed, 0, JSON.stringify(audit.snapshotLocators));
  assert.equal(audit.snapshotLocators.duplicateLocators, 0, JSON.stringify(audit.snapshotLocators));
  assert.equal(audit.stableRef.action.ok, true, JSON.stringify(audit.stableRef));
  assert.equal(audit.stableRef.count, 1, JSON.stringify(audit.stableRef));
  assert.equal(audit.popup.path, "/popup", JSON.stringify(audit.popup));
  assert.equal(audit.popup.title, "Popup fixture", JSON.stringify(audit.popup));
  assert.match(audit.popup.snapshot, /Popup ready/, JSON.stringify(audit.popup));
  assert.equal(audit.popup.evaluate, "Popup fixture", JSON.stringify(audit.popup));
  assert.equal(audit.delayed.clicked, 1, JSON.stringify(audit.delayed));
  assert.deepEqual(audit.actionOptions, {
    trialClicks: 0,
    forcedClicks: 1,
  });
  assert.equal(audit.expectation.text, "Success", JSON.stringify(audit.expectation));
  assert.equal(audit.events.consoleWait, "ufo-console-error");
  assert.match(audit.events.pageError, /ufo-page-error/);
  assert.equal(audit.events.requestMethod, "GET");
  assert.match(audit.events.requestFailure, /ERR_|Failed|Aborted|blocked/i);
  assert.ok(audit.events.consoleObserved >= 1);
  assert.ok(audit.events.pageErrorsObserved >= 1);
  assert.equal(audit.dialog.click.ok, true, JSON.stringify(audit.dialog));
  assert.ok(audit.dialog.elapsedMs < 500, JSON.stringify(audit.dialog));
  assert.equal(audit.dialog.message, "ufo-dialog", JSON.stringify(audit.dialog));
  assert.ok(audit.delayed.elapsedMs < 300, JSON.stringify(audit.delayed));
  assert.ok(audit.performance.typeTextP50Ms < 10, JSON.stringify(audit.performance));
  assert.ok(audit.performance.snapshotP50Ms < 2, JSON.stringify(audit.performance));
  assert.equal(audit.performance.snapshotMutationVisible, true, JSON.stringify(audit.performance));
  assert.equal(audit.performance.closeSuccesses, 5, JSON.stringify(audit.performance));
  assert.ok(audit.performance.closeP50Ms < 1, JSON.stringify(audit.performance));
  assert.equal(audit.performance.uploadSuccesses, 5, JSON.stringify(audit.performance));
  assert.ok(audit.performance.uploadP50Ms < 5, JSON.stringify(audit.performance));
  assert.ok(
    audit.performance.pageInfoP95Ms < microHelperP95BudgetMs,
    JSON.stringify(audit.performance),
  );
  assert.ok(
    audit.performance.waitForElementP95Ms < microHelperP95BudgetMs,
    JSON.stringify(audit.performance),
  );
  assert.ok(audit.performance.switchTabP95Ms < 5, JSON.stringify(audit.performance));
  assert.equal(audit.performance.clickSuccesses, 5, JSON.stringify(audit.performance));
  assert.ok(audit.performance.clickP50Ms < 150, JSON.stringify(audit.performance));

  const crossSnapshot = markedJson(
    await runCli(`
await useTaskSpace(${Number(taskId)})
await page.goto(${JSON.stringify(fixtureUrl + "?cross-heredoc=1")}, { timeout: 20000 })
const raw = await page.snapshotRaw()
const ref = raw.refs.find(entry => entry.role === 'button' && entry.name === 'Stale action')?.refId
if (!ref) throw new Error('cross-heredoc snapshot ref missing')
cliLog('__UFO_CROSS_REF__' + JSON.stringify({ ref }))
`),
    "__UFO_CROSS_REF__",
  );
  const crossHeredoc = { successes: 0, attempts: [] };
  for (let index = 0; index < 5; index += 1) {
    await runCli(`
await useTaskSpace(${Number(taskId)})
await page.goto(${JSON.stringify(fixtureUrl)} + '?cross-heredoc=' + ${Number(index)}, { waitUntil: 'load', timeout: 20000 })
`);
    const attempt = markedJson(
      await runCli(`
await useTaskSpace(${Number(taskId)})
await page.locator('@${Number(crossSnapshot.ref)}').click({ timeout: 1000 })
cliLog('__UFO_CROSS_RESULT__' + JSON.stringify({ count: await page.evaluate(() => window.fixture.state.stale) }))
`),
      "__UFO_CROSS_RESULT__",
    );
    crossHeredoc.attempts.push(attempt);
    if (attempt.count === 1) crossHeredoc.successes += 1;
  }
  assert.equal(crossHeredoc.successes, 5, JSON.stringify(crossHeredoc));

  await runCli(`
await useTaskSpace(${Number(taskId)})
await page.goto(${JSON.stringify(fixtureUrl + "?duplicate-stale=1")}, { waitUntil: 'load', timeout: 20000 })
`);
  const ambiguousRef = markedJson(
    await runCli(`
await useTaskSpace(${Number(taskId)})
let error
try { await page.locator('@${Number(crossSnapshot.ref)}').click({ timeout: 500 }) }
catch (caught) { error = { name: caught?.name, message: caught?.message || String(caught) } }
cliLog('__UFO_AMBIGUOUS_REF__' + JSON.stringify({ error, count: await page.evaluate(() => window.fixture.state.stale) }))
`),
    "__UFO_AMBIGUOUS_REF__",
  );
  assert.match(ambiguousRef.error?.message || "", /EGO_STALE_REF_AMBIGUOUS/);
  assert.equal(ambiguousRef.count, 0, JSON.stringify(ambiguousRef));

  process.stdout.write(
    `${JSON.stringify({ ok: true, ...audit, crossHeredoc, ambiguousRef }, null, 2)}\n`,
  );
} finally {
  if (taskId) {
    await runCli(`
cliLog(await completeTaskSpace(${Number(taskId)}, { keep: false }))
`).catch(() => undefined);
  }
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]).catch(
    () => undefined,
  );
  electron?.kill("SIGTERM");
  await closeServer(server);
}

function auditSource(fixtureUrl, oopifUrl, uploadPath, storageStatePath, tracePath) {
  return String.raw`
const task = await bootstrapTaskSpace({ name: ${JSON.stringify(`locator reliability ${Date.now()}`)} })
await openOrReuseTab(${JSON.stringify(fixtureUrl)}, { wait: true, timeout: 20 })
page.setDefaultTimeout(1000)

const resultOf = async operation => {
  const started = performance.now()
  try { return { ok: true, value: await operation(), ms: performance.now() - started } }
  catch (error) { return {
    ok: false,
    name: error?.name,
    message: error?.message || String(error),
    reason: error?.reason,
    interceptedBy: error?.interceptedBy,
    attempts: error?.attempts,
    screenshot: error?.screenshot,
    ms: performance.now() - started,
  } }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const p95 = values => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * .95) - 1)]
const covered = { permanentSilentSuccesses: 0, retrySuccesses: 0, attempts: [] }
const readonly = { successes: 0, attempts: [] }
const disabled = { successes: 0, attempts: [] }
const responseBody = { successes: 0, attempts: [] }

for (let index = 0; index < 5; index += 1) {
  await js('window.fixture.resetCovered(-1)')
  const permanent = await resultOf(() => page.locator('#covered').click({ timeout: 140 }))
  const permanentCount = await js('window.fixture.state.covered')
  if (permanent.ok && permanentCount === 0) covered.permanentSilentSuccesses += 1

  await js('window.fixture.resetCovered(70)')
  const retry = await resultOf(() => page.locator('#covered').click({ timeout: 500 }))
  const retryCount = await js('window.fixture.state.covered')
  if (retry.ok && retryCount === 1) covered.retrySuccesses += 1
  covered.attempts.push({ permanent, permanentCount, retry, retryCount })

  await js('window.fixture.resetReadonly(70)')
  const value = 'value-' + index
  const fill = await resultOf(() => page.locator('#readonly').fill(value, { timeout: 500 }))
  const filledValue = await page.locator('#readonly').inputValue()
  if (fill.ok && filledValue === value) readonly.successes += 1
  readonly.attempts.push({ fill, filledValue })

  await js('window.fixture.resetDisabled(250)')
  const clickDisabled = await resultOf(() => page.locator('#disabled').click({ timeout: 500 }))
  const disabledCount = await js('window.fixture.state.disabled')
  if (clickDisabled.ok && disabledCount === 1) disabled.successes += 1
  disabled.attempts.push({ click: clickDisabled, count: disabledCount })

  const responsePromise = page.waitForResponse(response => response.url().includes('/api?run=' + index), { timeout: 1000 })
  const fetchPromise = page.evaluate(run => fetch('/api?run=' + run).then(response => response.text()), index)
  const response = await responsePromise
  const body = await resultOf(() => response.json())
  await fetchPromise
  if (body.ok && body.value?.run === index) responseBody.successes += 1
  responseBody.attempts.push(body)
}

await page.route('**/route-fulfill', route => route.fulfill({ status: 201, json: { source: 'route' } }))
const fulfilled = await page.evaluate(() => fetch('/route-fulfill').then(async response => ({ status: response.status, body: await response.json() })))
await page.route('**/route-continue', route => {
  const request = route.request()
  return route.continue({ headers: { ...request.headers(), 'x-ufo-route': 'yes' } })
})
const continued = await page.evaluate(() => fetch('/route-continue').then(response => response.json()))
await page.route('**/route-abort', route => route.abort())
const aborted = await page.evaluate(() => fetch('/route-abort').then(() => false, () => true))
await page.unrouteAll()
const unrouted = await page.evaluate(() => fetch('/route-fulfill').then(response => response.json()))
const routing = { fulfilled, continued, aborted, unrouted }

const consoleEvents = []
const pageErrors = []
const requestEvents = []
const failedRequests = []
page.on('console', message => consoleEvents.push(message.type() + ':' + message.text()))
page.on('pageerror', error => pageErrors.push(error.message))
page.on('request', request => requestEvents.push(request.method() + ' ' + request.url()))
page.on('requestfailed', request => failedRequests.push(request.failure()?.errorText || ''))
const consolePromise = page.waitForEvent('console', message => message.text().includes('ufo-console-error'), { timeout: 1000 })
await page.evaluate(() => console.error('ufo-console-error'))
const consoleMessage = await consolePromise
const pageErrorPromise = page.waitForEvent('pageerror', error => error.message.includes('ufo-page-error'), { timeout: 1000 })
await page.evaluate(() => setTimeout(() => { throw new Error('ufo-page-error') }, 0))
const pageError = await pageErrorPromise
const requestPromise = page.waitForEvent('request', request => request.url().includes('/event-request'), { timeout: 1000 })
const eventRequestFetch = page.evaluate(() => fetch('/event-request').then(response => response.text()))
const requestEvent = await requestPromise
await eventRequestFetch
const requestFailurePromise = page.waitForEvent('requestfailed', request => request.url().includes('/event-fail'), { timeout: 3000 })
await page.evaluate(() => fetch('/event-fail').catch(() => 'failed'))
const requestFailure = await requestFailurePromise
const events = {
  consoleWait: consoleMessage.text(),
  pageError: pageError.message,
  requestMethod: requestEvent.method(),
  requestFailure: requestFailure.failure()?.errorText || '',
  consoleObserved: consoleEvents.length,
  pageErrorsObserved: pageErrors.length,
  requestsObserved: requestEvents.length,
  failuresObserved: failedRequests.length,
}

const dialogStarted = performance.now()
const dialogClick = await resultOf(() => page.locator('#dialog').click({ timeout: 1000 }))
const dialogElapsedMs = performance.now() - dialogStarted
const dialogInfo = await pageInfo()
await cdp('Page.handleJavaScriptDialog', { accept: true })
const dialog = {
  click: dialogClick,
  elapsedMs: dialogElapsedMs,
  message: dialogInfo.dialog?.message || '',
}

await page.evaluate(() => {
  localStorage.setItem('ufo-state', 'alpha')
  document.cookie = 'ufo_state_cookie=alpha; path=/'
})
const capturedStorageState = await page.storageState({ path: ${JSON.stringify(storageStatePath)} })
await page.evaluate(() => {
  localStorage.clear()
  document.cookie = 'ufo_state_cookie=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
})
await page.setStorageState(capturedStorageState, { clear: true })
const restoredStorageState = await page.evaluate(() => ({
  localStorage: localStorage.getItem('ufo-state'),
  cookie: document.cookie.split('; ').find(value => value.startsWith('ufo_state_cookie='))?.split('=')[1] || '',
}))
const storageState = restoredStorageState

await page.tracing.start({ categories: ['devtools.timeline', 'blink.user_timing'] })
await page.evaluate(() => {
  performance.mark('ufo-trace-marker')
  performance.measure('ufo-trace-measure', 'ufo-trace-marker')
})
const savedTracePath = await page.tracing.stop({ path: ${JSON.stringify(tracePath)} })
const trace = { path: savedTracePath }

await page.getByRole('checkbox').check()
await page.getByRole('combobox').selectOption('two')
const roles = {
  checkbox: await page.getByRole('checkbox').isChecked(),
  combobox: await page.getByRole('combobox').inputValue(),
}

const shadowAction = await resultOf(() => page.locator('#shadow-button').click({ timeout: 500 }))
const shadow = {
  action: shadowAction,
  cssClick: await js('window.fixture.state.shadow'),
}

const frameAction = await resultOf(() => page.frameLocator('#fixture-frame').getByRole('button', { name: 'Frame action' }).click({ timeout: 800 }))
await page.frameLocator('#fixture-frame').locator('#frame-input').fill('frame value')
const frameInputValue = await page.frameLocator('#fixture-frame').locator('#frame-input').inputValue()
const frameButtonCount = await page.frameLocator('#fixture-frame').getByRole('button').count()
await page.frameLocator('#fixture-frame').frameLocator('#nested-frame').getByRole('button', { name: 'Nested action' }).click({ timeout: 800 })
const frame = {
  action: frameAction,
  clicks: await js("document.querySelector('#fixture-frame').contentWindow.fixtureClicks"),
  inputValue: frameInputValue,
  buttonCount: frameButtonCount,
  nestedClicks: await js("document.querySelector('#fixture-frame').contentWindow.document.querySelector('#nested-frame').contentWindow.fixtureClicks"),
}

const staleSnapshot = await page.snapshotRaw()
const snapshotLocatorChecks = []
for (const ref of staleSnapshot.refs.filter(ref => ref.loc)) {
  const count = await page.locator(ref.loc).count()
  snapshotLocatorChecks.push({ loc: ref.loc, count })
}
const snapshotLocators = {
  checked: snapshotLocatorChecks.length,
  failed: snapshotLocatorChecks.filter(check => check.count !== 1).length,
  duplicateLocators: staleSnapshot.refs.filter(ref => ref.name === 'Duplicate action' && ref.loc).length,
  checks: snapshotLocatorChecks,
}
const stableRefId = staleSnapshot.refs.find(ref => ref.role === 'link' && ref.name === 'Stable link')?.refId
if (!stableRefId) throw new Error('snapshot did not expose the stable-link fixture')
await js('window.fixture.replaceStableLink()')
const stableRefAction = await resultOf(() => page.locator('@' + stableRefId).click({ timeout: 500 }))
const stableRef = { action: stableRefAction, count: await js('window.fixture.state.stableLink') }
const staleRefId = staleSnapshot.refs.find(ref => ref.role === 'button' && ref.name === 'Stale action')?.refId
if (!staleRefId) throw new Error('snapshot did not expose the stale-ref fixture')
const staleRef = { successes: 0, attempts: [], maxElapsedMs: 0 }
for (let index = 0; index < 5; index += 1) {
  await page.goto(${JSON.stringify(fixtureUrl)} + '?stale=' + index, { timeout: 20000 })
  const action = await resultOf(() => page.locator('@' + staleRefId).click({ timeout: 500 }))
  const count = await js('window.fixture.state.stale')
  if (action.ok && count === 1) staleRef.successes += 1
  staleRef.maxElapsedMs = Math.max(staleRef.maxElapsedMs, action.ms)
  staleRef.attempts.push({ action, count })
}

await js('window.fixture.createDelayed(180)')
const delayedStarted = performance.now()
const delayedAction = await resultOf(() => page.locator('#delayed').click({ timeout: 800 }))
const delayed = {
  action: delayedAction,
  elapsedMs: performance.now() - delayedStarted,
  clicked: await js('window.fixture.state.delayed'),
}

await page.evaluate(() => {
  const status = document.querySelector('#expect-status')
  status.textContent = 'Working'
  setTimeout(() => { status.textContent = 'Success' }, 120)
})
await expect(page.locator('#expect-status')).toHaveText('Success', { timeout: 800 })
const expectation = { text: await page.locator('#expect-status').innerText() }

await page.evaluate(() => { window.fixture.state.fast = 0 })
await page.locator('#fast').click({ trial: true, timeout: 500 })
const trialClicks = await page.evaluate(() => window.fixture.state.fast)
await page.evaluate(() => window.fixture.resetCovered(-1))
await page.locator('#covered').click({ force: true, timeout: 500 })
const forcedClicks = await page.evaluate(() => window.fixture.state.covered)
const actionOptions = { trialClicks, forcedClicks }

const typeTextSamples = []
const snapshotSamples = []
const uploadSamples = []
const pageInfoSamples = []
const waitForElementSamples = []
const clickSamples = []
let clickSuccesses = 0
let uploadSuccesses = 0
await snapshotText()
for (let index = 0; index < 5; index += 1) {
  const snapshotStarted = performance.now()
  const content = await snapshotText()
  snapshotSamples.push(performance.now() - snapshotStarted)
  if (!content.includes('Locator reliability fixture')) throw new Error('snapshot lost fixture content')
}
await js("document.body.append(Object.assign(document.createElement('button'), { id: 'snapshot-mutation', textContent: 'Snapshot mutation' }))")
const snapshotMutationVisible = (await snapshotText()).includes('Snapshot mutation')
for (let index = 0; index < 5; index += 1) {
  const infoStarted = performance.now()
  const info = await pageInfo()
  pageInfoSamples.push(performance.now() - infoStarted)
  if (!info.url.includes(${JSON.stringify(fixtureUrl)})) throw new Error('pageInfo returned the wrong page')

  const waitStarted = performance.now()
  await waitForElement('#fast', { timeout: 1 })
  waitForElementSamples.push(performance.now() - waitStarted)
}
await page.evaluate(url => window.fixture.createOopif(url), ${JSON.stringify(oopifUrl)})
let oopifTargetId = null
for (let attempt = 0; attempt < 50 && !oopifTargetId; attempt += 1) {
  oopifTargetId = await iframeTarget('oopif.localhost')
  if (!oopifTargetId) await new Promise(resolve => setTimeout(resolve, 20))
}
await page.frameLocator('#oopif-frame').getByRole('button', { name: 'OOPIF action' }).click({ timeout: 1000 })
await page.frameLocator('#oopif-frame').locator('#oopif-input').fill('oopif value')
frame.oopifTarget = Boolean(oopifTargetId)
frame.oopifClicks = await page.frameLocator('#oopif-frame').locator('#oopif-count').innerText()
frame.oopifInputValue = await page.frameLocator('#oopif-frame').locator('#oopif-input').inputValue()
for (let index = 0; index < 5; index += 1) {
  const uploadStarted = performance.now()
  await setInputFiles('#upload', ${JSON.stringify(uploadPath)})
  uploadSamples.push(performance.now() - uploadStarted)
  if (await js("document.querySelector('#upload').files?.[0]?.name === 'upload-fixture.txt'")) uploadSuccesses += 1
}
for (let index = 0; index < 5; index += 1) {
  await page.locator('#typing').fill('')
  await page.locator('#typing').focus()
  const typeStarted = performance.now()
  await typeText('abcdefghij')
  typeTextSamples.push(performance.now() - typeStarted)

  const before = await js('window.fixture.state.fast')
  const clickStarted = performance.now()
  await page.locator('#fast').click()
  clickSamples.push(performance.now() - clickStarted)
  const after = await js('window.fixture.state.fast')
  if (after === before + 1) clickSuccesses += 1
}

const opener = await currentTab()
const popupPromise = resultOf(() => page.waitForEvent('popup', { timeout: 1000 }))
const popupClick = await resultOf(() => page.locator('#popup').click({ timeout: 500 }))
const popupResult = await popupPromise
const popupTabs = await listTabs()
const discoveredPopup = popupTabs.find(tab => tab.targetId !== opener.targetId && new URL(tab.url).pathname === '/popup')
const popupUrl = popupResult.ok
  ? (typeof popupResult.value.url === 'function' ? await popupResult.value.url() : popupResult.value.url)
  : discoveredPopup?.url || ''
const popupInfo = popupResult.ok ? await popupResult.value.pageInfo() : null
const popupSnapshot = popupResult.ok ? await popupResult.value.snapshotText() : ''
const popupEvaluate = popupResult.ok ? await popupResult.value.evaluate(() => document.title) : ''
const popup = {
  click: popupClick,
  result: popupResult.ok ? { ok: true } : popupResult,
  path: popupUrl ? new URL(popupUrl).pathname : '',
  title: popupInfo?.title || '',
  snapshot: popupSnapshot,
  evaluate: popupEvaluate,
}
if (discoveredPopup) await closeTab(discoveredPopup.targetId)
await switchTab(opener.targetId)

const switchCreated = await createTab('about:blank#switch-performance')
const switchTargetId = switchCreated.targetId || switchCreated
await switchTab(opener.targetId)
const switchTabSamples = []
for (let index = 0; index < 5; index += 1) {
  const targetId = index % 2 === 0 ? switchTargetId : opener.targetId
  const switchStarted = performance.now()
  await switchTab(targetId)
  switchTabSamples.push(performance.now() - switchStarted)
}
await closeTab(switchTargetId)
await switchTab(opener.targetId)

const tabsToClose = []
for (let index = 0; index < 5; index += 1) {
  const created = await createTab('about:blank#close-' + index)
  tabsToClose.push(created.targetId || created)
}
const closeSamples = []
for (const targetId of tabsToClose) {
  const closeStarted = performance.now()
  await closeTab(targetId)
  closeSamples.push(performance.now() - closeStarted)
}
const remainingTargetIds = new Set((await listTabs()).map(tab => tab.targetId))
const closeSuccesses = tabsToClose.filter(targetId => !remainingTargetIds.has(targetId)).length
await switchTab(opener.targetId)

cliLog('__UFO_LOCATOR_RELIABILITY__' + JSON.stringify({
  taskId: task.id,
  covered,
  readonly,
  disabled,
  responseBody,
  routing,
  storageState,
  trace,
  roles,
  shadow,
  frame,
  staleRef,
  snapshotLocators,
  stableRef,
  popup,
  delayed,
  actionOptions,
  expectation,
  events,
  dialog,
  performance: {
    typeTextSamples,
    typeTextP50Ms: median(typeTextSamples),
    snapshotSamples,
    snapshotP50Ms: median(snapshotSamples),
    snapshotMutationVisible,
    closeSamples,
    closeP50Ms: median(closeSamples),
    closeSuccesses,
    uploadSamples,
    uploadP50Ms: median(uploadSamples),
    uploadSuccesses,
    pageInfoSamples,
    pageInfoP95Ms: p95(pageInfoSamples),
    waitForElementSamples,
    waitForElementP95Ms: p95(waitForElementSamples),
    switchTabSamples,
    switchTabP95Ms: p95(switchTabSamples),
    clickSamples,
    clickP50Ms: median(clickSamples),
    clickSuccesses,
  },
}))
`;
}

function createFixtureServer() {
  return createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    response.setHeader("cache-control", "no-store");
    if (url.pathname === "/api") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: true, run: Number(url.searchParams.get("run")) }));
      return;
    }
    if (url.pathname === "/route-fulfill") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ source: "network" }));
      return;
    }
    if (url.pathname === "/route-continue") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ routeHeader: request.headers["x-ufo-route"] || "" }));
      return;
    }
    if (url.pathname === "/route-abort") {
      response.end("should not reach the network");
      return;
    }
    if (url.pathname === "/event-fail") {
      response.socket?.destroy();
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/frame") {
      response.end(`<!doctype html><meta charset="utf-8"><button id="frame-action">Frame action</button><input id="frame-input"><iframe id="nested-frame" src="/nested-frame"></iframe><script>window.fixtureClicks=0;document.querySelector('#frame-action').onclick=()=>window.fixtureClicks++<\/script>`);
      return;
    }
    if (url.pathname === "/nested-frame") {
      response.end(`<!doctype html><meta charset="utf-8"><button id="nested-action">Nested action</button><script>window.fixtureClicks=0;document.querySelector('#nested-action').onclick=()=>window.fixtureClicks++<\/script>`);
      return;
    }
    if (url.pathname === "/oopif") {
      response.end(`<!doctype html><meta charset="utf-8"><button id="oopif-action">OOPIF action</button><span id="oopif-count">0</span><input id="oopif-input"><script>document.querySelector('#oopif-action').onclick=()=>document.querySelector('#oopif-count').textContent=String(Number(document.querySelector('#oopif-count').textContent)+1)<\/script>`);
      return;
    }
    if (url.pathname === "/popup") {
      response.end(`<!doctype html><meta charset="utf-8"><title>Popup fixture</title><main>Popup ready</main>`);
      return;
    }
    response.end(`<!doctype html>
      <meta charset="utf-8">
      <title>Locator reliability fixture</title>
      <style>
        #covered-wrap { position: relative; width: 220px; height: 48px; }
        #covered, #cover { position: absolute; inset: 0; }
        #cover { z-index: 2; background: rgba(0,0,0,.2); }
      </style>
      <div id="covered-wrap"><button id="covered">Covered action</button><div id="cover"></div></div>
      <input id="readonly" readonly>
      <button id="disabled" disabled>Disabled action</button>
      <label><input id="checkbox" type="checkbox"> Native checkbox</label>
      <label>Native combo<select id="combo"><option value="one">One</option><option value="two">Two</option></select></label>
      <div id="shadow-host"></div>
      <iframe id="fixture-frame" src="/frame"></iframe>
      <button id="popup">Open popup</button>
      <button id="dialog">Open dialog</button>
      <div id="delayed-root"></div>
      <input id="typing">
      <input id="upload" type="file">
      <button id="fast">Fast action</button>
      <button id="stale">Stale action</button>
      ${url.searchParams.has("duplicate-stale") ? '<button id="stale-duplicate">Stale action</button>' : ""}
      <div id="expect-status">Idle</div>
      <a id="stable-link" href="#stable-target">Stable link</a>
      <button>Duplicate action</button><button>Duplicate action</button>
      <script>
        const state = { covered: 0, disabled: 0, shadow: 0, delayed: 0, fast: 0, stale: 0, stableLink: 0 };
        const cover = document.querySelector('#cover');
        document.querySelector('#covered').onclick = () => state.covered++;
        document.querySelector('#disabled').onclick = () => state.disabled++;
        document.querySelector('#fast').onclick = () => state.fast++;
        document.querySelector('#stale').onclick = () => state.stale++;
        document.querySelector('#stable-link').onclick = event => { event.preventDefault(); state.stableLink++; };
        document.querySelector('#popup').onclick = () => window.open('/popup', '_blank');
        document.querySelector('#dialog').onclick = () => alert('ufo-dialog');
        const shadow = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
        shadow.innerHTML = '<button id="shadow-button">Shadow action</button>';
        shadow.querySelector('#shadow-button').onclick = () => state.shadow++;
        window.fixture = {
          state,
          resetCovered(delay) {
            state.covered = 0;
            cover.style.display = 'block';
            if (delay >= 0) setTimeout(() => cover.style.display = 'none', delay);
          },
          resetReadonly(delay) {
            const input = document.querySelector('#readonly');
            input.value = 'seed';
            input.readOnly = true;
            setTimeout(() => input.readOnly = false, delay);
          },
          resetDisabled(delay) {
            const button = document.querySelector('#disabled');
            state.disabled = 0;
            button.disabled = true;
            setTimeout(() => button.disabled = false, delay);
          },
          createDelayed(delay) {
            state.delayed = 0;
            document.querySelector('#delayed-root').replaceChildren();
            setTimeout(() => {
              const button = document.createElement('button');
              button.id = 'delayed';
              button.textContent = 'Delayed action';
              button.onclick = () => state.delayed++;
              document.querySelector('#delayed-root').append(button);
            }, delay);
          },
          createOopif(url) {
            const frame = document.createElement('iframe');
            frame.id = 'oopif-frame';
            frame.src = url;
            document.body.append(frame);
          },
          replaceStableLink() {
            const previous = document.querySelector('#stable-link');
            const link = document.createElement('a');
            link.id = 'stable-link';
            link.href = '#stable-target';
            link.textContent = 'Renamed stable link';
            link.onclick = event => { event.preventDefault(); state.stableLink++; };
            previous.replaceWith(link);
          },
        };
      <\/script>`);
  });
}

function listen(target) {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => {
      target.off("error", reject);
      resolve(target.address().port);
    });
  });
}

function closeServer(target) {
  if (!target) return Promise.resolve();
  target.closeIdleConnections?.();
  target.closeAllConnections?.();
  return new Promise((resolve) => target.close(() => resolve()));
}

async function waitForTestSocket(timeoutMs) {
  const marker = join(testRoot, "socket-path");
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const socketPath = (await readFile(marker, "utf8")).trim();
      await connectOnce(socketPath);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`test App socket did not become ready: ${String(lastError)}`);
}

function connectOnce(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", reject);
  });
}

function runCli(source = "") {
  return runProcess(join(root, "dist/bin/ufo-browser"), ["nodejs"], source);
}

function markedJson(output, marker) {
  const line = output.split(/\r?\n/).find((value) => value.startsWith(marker));
  if (!line) throw new Error(`missing ${marker} in CLI output: ${output}`);
  return JSON.parse(line.slice(marker.length));
}

function runProcess(command, args, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
    child.stdin.end(stdin);
  });
}
