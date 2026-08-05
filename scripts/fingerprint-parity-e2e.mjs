import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";

const root = process.cwd();
const testNamespace = "fingerprint-parity";
const testRoot = join(root, ".x-browser-test", "runs", testNamespace);
process.env.X_BROWSER_TEST_NAMESPACE = testNamespace;
process.env.X_BROWSER_SOCKET = join(testRoot, "x-browser.sock");
const frameServer = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end("<!doctype html><title>Fingerprint Frame</title><main>frame</main>");
});
let pageServer;
let electron;
let taskId;
let egoTaskId;
let evidenceWritten = false;

const coreProbeExpression = String.raw`(async () => {
  const permissionNames = [
    'geolocation', 'notifications', 'camera', 'microphone',
    'clipboard-read', 'clipboard-write', 'midi', 'persistent-storage',
    'payment-handler', 'window-management', 'local-fonts'
  ]
  const permissions = {}
  for (const name of permissionNames) {
    try { permissions[name] = (await navigator.permissions.query({ name })).state }
    catch (error) { permissions[name] = error?.name || String(error) }
  }
  const chromeDescriptor = Object.getOwnPropertyDescriptor(window, 'chrome')
  const navigatorPrototype = Navigator.prototype
  const languagesDescriptor = Object.getOwnPropertyDescriptor(navigatorPrototype, 'languages')
  const webdriverDescriptor = Object.getOwnPropertyDescriptor(navigatorPrototype, 'webdriver')
  const hardwareDescriptor = Object.getOwnPropertyDescriptor(navigatorPrototype, 'hardwareConcurrency')
  const pluginsDescriptor = Object.getOwnPropertyDescriptor(navigatorPrototype, 'plugins')
  const queryDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator.permissions), 'query')
  const estimateDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator.storage), 'estimate')
  const connection = navigator.connection || navigator.webkitConnection || navigator.mozConnection
  return {
    navigator: {
      userAgent: navigator.userAgent,
      appVersion: navigator.appVersion,
      language: navigator.language,
      languages: navigator.languages,
      webdriver: navigator.webdriver,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints,
      platform: navigator.platform,
      vendor: navigator.vendor,
      productSub: navigator.productSub,
      cookieEnabled: navigator.cookieEnabled,
      pdfViewerEnabled: navigator.pdfViewerEnabled,
      doNotTrack: navigator.doNotTrack,
      globalPrivacyControl: navigator.globalPrivacyControl,
      plugins: Array.from(navigator.plugins, plugin => ({
        name: plugin.name,
        filename: plugin.filename,
        description: plugin.description,
        mimeTypes: Array.from(plugin, mime => mime.type),
      })),
      mimeTypes: Array.from(navigator.mimeTypes, mime => ({
        type: mime.type,
        suffixes: mime.suffixes,
        description: mime.description,
        plugin: mime.enabledPlugin?.name || null,
      })),
      connection: connection ? {
        effectiveType: connection.effectiveType,
        downlink: connection.downlink,
        rtt: connection.rtt,
        saveData: connection.saveData,
      } : null,
      uaData: navigator.userAgentData ? {
        brands: navigator.userAgentData.brands,
        mobile: navigator.userAgentData.mobile,
        platform: navigator.userAgentData.platform,
        high: await navigator.userAgentData.getHighEntropyValues([
          'architecture', 'bitness', 'fullVersionList', 'formFactors',
          'model', 'platformVersion', 'uaFullVersion', 'wow64'
        ])
      } : null,
    },
    descriptors: {
      languages: String(languagesDescriptor?.get),
      webdriver: String(webdriverDescriptor?.get),
      hardwareConcurrency: String(hardwareDescriptor?.get),
      plugins: String(pluginsDescriptor?.get),
    },
    chrome: {
      keys: Object.keys(window.chrome || {}).sort(),
      appKeys: Object.keys(window.chrome?.app || {}).sort(),
      descriptor: chromeDescriptor ? {
        configurable: chromeDescriptor.configurable,
        enumerable: chromeDescriptor.enumerable,
        writable: chromeDescriptor.writable,
        hasGetter: typeof chromeDescriptor.get === 'function',
      } : null,
      functions: {
        loadTimes: String(chrome.loadTimes),
        csi: String(chrome.csi),
        getDetails: String(chrome.app.getDetails),
        getIsInstalled: String(chrome.app.getIsInstalled),
        installState: String(chrome.app.installState),
        runningState: String(chrome.app.runningState),
      },
    },
    stealth: {
      functionToString: String(Function.prototype.toString),
      languagesGetter: String(languagesDescriptor.get),
      permissionsQuery: String(queryDescriptor.value),
      storageEstimate: String(estimateDescriptor.value),
      automationGlobals: Object.getOwnPropertyNames(window).filter(name => /cdc_|webdriver|selenium|phantom/i.test(name)).sort(),
    },
    permissions,
    notificationPermission: Notification.permission,
    storage: await navigator.storage.estimate(),
    locale: {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      calendar: Intl.DateTimeFormat().resolvedOptions().calendar,
      numberingSystem: Intl.DateTimeFormat().resolvedOptions().numberingSystem,
      hourCycle: Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle,
    },
    window: {
      innerWidth, innerHeight, outerWidth, outerHeight,
      screenX, screenY,
      devicePixelRatio,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      visualViewport: visualViewport ? {
        width: visualViewport.width,
        height: visualViewport.height,
        scale: visualViewport.scale,
      } : null,
    },
    screen: {
      width: screen.width, height: screen.height,
      availWidth: screen.availWidth, availHeight: screen.availHeight,
      availLeft: screen.availLeft, availTop: screen.availTop,
      colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
      orientation: screen.orientation ? {
        type: screen.orientation.type,
        angle: screen.orientation.angle,
      } : null,
    },
  }
})()`;

const graphicsProbeExpression = String.raw`(async () => {
  const hash = (value) => {
    let state = 2166136261
    for (let index = 0; index < value.length; index += 1) {
      state ^= value.charCodeAt(index)
      state = Math.imul(state, 16777619)
    }
    return (state >>> 0).toString(16).padStart(8, '0')
  }
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 120
  const context = canvas.getContext('2d')
  context.textBaseline = 'alphabetic'
  context.fillStyle = '#f4f8f6'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#183c32'
  context.font = '17px Arial'
  context.fillText('X-Browser / Ego fingerprint 🧭', 12, 34)
  context.fillStyle = 'rgba(73, 133, 239, .68)'
  context.beginPath()
  context.arc(84, 78, 26, 0, Math.PI * 2)
  context.fill()
  context.globalCompositeOperation = 'multiply'
  context.fillStyle = 'rgba(237, 95, 118, .62)'
  context.fillRect(76, 58, 64, 42)
  context.globalCompositeOperation = 'source-over'
  const collectGl = (kind) => {
    const surface = document.createElement('canvas')
    const gl = surface.getContext(kind)
    if (!gl) return null
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)
    return {
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)),
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      highFloat: precision ? {
        rangeMin: precision.rangeMin,
        rangeMax: precision.rangeMax,
        precision: precision.precision,
      } : null,
    }
  }
  const audio = await (async () => {
    try {
      const realtime = new AudioContext()
      const result = {
        sampleRate: realtime.sampleRate,
        baseLatency: realtime.baseLatency,
        outputLatency: realtime.outputLatency,
        state: realtime.state,
      }
      await realtime.close()
      return result
    } catch (error) {
      return { error: error?.name || String(error) }
    }
  })()
  const video = document.createElement('video')
  return {
    webgl: collectGl('webgl'),
    webgl2: collectGl('webgl2'),
    canvasSignature: hash(canvas.toDataURL()),
    audio,
    userActivation: {
      isActive: navigator.userActivation.isActive,
      hasBeenActive: navigator.userActivation.hasBeenActive,
    },
    codecs: {
      h264: video.canPlayType('video/mp4; codecs="avc1.42E01E"'),
      hevc: video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      vp9: video.canPlayType('video/webm; codecs="vp9"'),
      av1: video.canPlayType('video/mp4; codecs="av01.0.05M.08"'),
      opus: video.canPlayType('audio/webm; codecs="opus"'),
    },
    fonts: {
      Arial: document.fonts.check('16px Arial'),
      Helvetica: document.fonts.check('16px Helvetica'),
      SFPro: document.fonts.check('16px "SF Pro Text"'),
      PingFang: document.fonts.check('16px "PingFang SC"'),
      Menlo: document.fonts.check('16px Menlo'),
      Monaco: document.fonts.check('16px Monaco'),
    },
    mediaQueries: {
      colorGamutP3: matchMedia('(color-gamut: p3)').matches,
      dynamicRangeHigh: matchMedia('(dynamic-range: high)').matches,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      darkMode: matchMedia('(prefers-color-scheme: dark)').matches,
      pointerFine: matchMedia('(pointer: fine)').matches,
      hover: matchMedia('(hover: hover)').matches,
    },
    features: {
      bluetooth: 'bluetooth' in navigator,
      gpu: 'gpu' in navigator,
      hid: 'hid' in navigator,
      serial: 'serial' in navigator,
      usb: 'usb' in navigator,
      wakeLock: 'wakeLock' in navigator,
      sharedArrayBuffer: typeof SharedArrayBuffer,
      crossOriginIsolated,
    },
    memory: performance.memory ? {
      jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
    } : null,
  }
})()`;

try {
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]);
  const framePort = await listen(frameServer);
  pageServer = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      `<!doctype html><title>Fingerprint Root</title><main>root</main><iframe src="http://localhost:${framePort}/frame"></iframe>`,
    );
  });
  const pagePort = await listen(pageServer);
  electron = spawn(join(root, "node_modules/.bin/electron"), ["."], {
    cwd: root,
    env: { ...process.env, X_BROWSER_TEST_APP: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitForTestSocket(20_000);

  const egoAudit = await runBrowserAudit(
    runEgoCli,
    `ego fingerprint parity ${Date.now()}`,
    pagePort,
    "Ego",
  );
  egoTaskId = egoAudit.taskId;

  const audit = await runBrowserAudit(
    runCli,
    `x-browser fingerprint parity ${Date.now()}`,
    pagePort,
    "X-Browser",
  );
  taskId = audit.taskId;
  verifyFingerprint(audit.root, true);
  verifyFingerprint(audit.frame, false);
  const parity = {
    rootDifferences: fingerprintDifferences(egoAudit.root, audit.root),
    frameDifferences: fingerprintDifferences(egoAudit.frame, audit.frame),
  };
  const unexpectedDifferences = [
    ...parity.rootDifferences.map((difference) => ({
      scope: "root",
      ...difference,
    })),
    ...parity.frameDifferences.map((difference) => ({
      scope: "frame",
      ...difference,
    })),
  ].filter((difference) => !isAllowedFingerprintDifference(difference.path));
  assert.deepEqual(audit.frame.navigator.languages, audit.root.navigator.languages);
  assert.equal(audit.frame.navigator.userAgent, audit.root.navigator.userAgent);
  assert.deepEqual(audit.frame.navigator.uaData, audit.root.navigator.uaData);
  assert.equal(audit.root.window.visibilityState, "visible");
  assert.equal(
    audit.root.window.hasFocus,
    false,
    "background Agent page matches Ego's unfocused document state",
  );
  assert.equal(
    audit.frame.window.hasFocus,
    false,
    "cross-origin Agent frame inherits the unfocused document state",
  );
  assert.ok(
    audit.root.window.outerHeight > audit.root.window.innerHeight,
    "background page retains normal browser chrome geometry",
  );

  const evidence = {
    ok: unexpectedDifferences.length === 0,
    egoBaselineVersion: "0.4.5.8",
    deliberateDifferences: {
      chromiumPatch:
        "X-Browser keeps its embedded Chromium patch version instead of overriding UAData, because a page-level override regressed JanitorAI Turnstile.",
      viewport:
        "X-Browser keeps outerHeight greater than innerHeight to model ordinary browser chrome, while the audited Ego background surface reported equal values.",
      connection:
        "NetworkInformation downlink and RTT are live connection estimates and are expected to vary between processes and sampling moments.",
    },
    unexpectedDifferences,
    parity,
    ego: egoAudit,
    ...audit,
  };
  await mkdir(testRoot, { recursive: true });
  await writeFile(
    join(testRoot, "fingerprint-parity-audit.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  evidenceWritten = true;
  assert.deepEqual(
    unexpectedDifferences,
    [],
    "fingerprint drift exceeded the deliberate connection/version/viewport allowlist",
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      auditPath: join(testRoot, "fingerprint-parity-audit.json"),
      allowedDifferences: {
        root: parity.rootDifferences.length,
        frame: parity.frameDifferences.length,
      },
    })}\n`,
  );
} catch (error) {
  if (!evidenceWritten) {
    await mkdir(testRoot, { recursive: true }).catch(() => undefined);
    await writeFile(
      join(testRoot, "fingerprint-parity-audit.json"),
      `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`,
    ).catch(() => undefined);
  }
  throw error;
} finally {
  if (taskId) {
    await runCli(`
cliLog(await completeTaskSpace(${Number(taskId)}, { keep: false }))
`).catch(() => undefined);
  }
  if (egoTaskId) {
    await runEgoCli(`
cliLog(JSON.stringify(await completeTaskSpace(${Number(egoTaskId)}, { keep: false })))
`).catch(() => undefined);
  }
  await runProcess(process.execPath, ["scripts/stop-test-app.mjs"]).catch(
    () => undefined,
  );
  electron?.kill("SIGTERM");
  await closeServer(pageServer);
  await closeServer(frameServer);
}

function verifyFingerprint(fingerprint, topLevel) {
  assert.match(fingerprint.navigator.userAgent, /Chrome\/150\.0\.0\.0/);
  assert.doesNotMatch(fingerprint.navigator.userAgent, /Electron|Headless/i);
  assert.equal(fingerprint.navigator.language, "zh-CN");
  assert.deepEqual(fingerprint.navigator.languages, ["zh-CN", "zh"]);
  assert.equal(fingerprint.navigator.webdriver, false);
  assert.equal(fingerprint.navigator.hardwareConcurrency, 8);
  assert.equal(fingerprint.navigator.deviceMemory, 16);
  assert.equal(fingerprint.navigator.platform, "MacIntel");
  assert.equal(fingerprint.navigator.vendor, "Google Inc.");
  assert.deepEqual(fingerprint.navigator.plugins.map((plugin) => plugin.name), [
    "PDF Viewer",
    "Chrome PDF Viewer",
    "Chromium PDF Viewer",
    "Microsoft Edge PDF Viewer",
    "WebKit built-in PDF",
  ]);
  assert.deepEqual(fingerprint.chrome.keys, ["app", "csi", "loadTimes"]);
  assert.deepEqual(fingerprint.chrome.appKeys, [
    "InstallState",
    "RunningState",
    "getDetails",
    "getIsInstalled",
    "installState",
    "isInstalled",
    "runningState",
  ]);
  assert.deepEqual(fingerprint.chrome.descriptor, {
    configurable: false,
    enumerable: true,
    writable: true,
    hasGetter: false,
  });
  assert.deepEqual(fingerprint.chrome.functions, {
    loadTimes: "function () { [native code] }",
    csi: "function () { [native code] }",
    getDetails: "function getDetails() { [native code] }",
    getIsInstalled: "function getIsInstalled() { [native code] }",
    installState: "function installState() { [native code] }",
    runningState: "function runningState() { [native code] }",
  });
  assert.deepEqual(fingerprint.stealth, {
    functionToString: "function toString() { [native code] }",
    languagesGetter: "function get languages() { [native code] }",
    permissionsQuery: "function query() { [native code] }",
    storageEstimate: "function estimate() { [native code] }",
    automationGlobals: [],
  });
  assert.deepEqual(
    pick(fingerprint.permissions, [
      "geolocation",
      "notifications",
      "camera",
      "microphone",
      "clipboard-read",
      "clipboard-write",
    ]),
    topLevel
      ? {
          geolocation: "prompt",
          notifications: "prompt",
          camera: "prompt",
          microphone: "prompt",
          "clipboard-read": "prompt",
          "clipboard-write": "granted",
        }
      : {
          geolocation: "denied",
          notifications: "denied",
          camera: "denied",
          microphone: "denied",
          "clipboard-read": "denied",
          "clipboard-write": "denied",
        },
  );
  assert.equal(fingerprint.storage.quota, 10 * 1024 ** 3);
  assert.equal(fingerprint.webgl.vendor, "WebKit");
  assert.equal(fingerprint.webgl.renderer, "WebKit WebGL");
  assert.equal(fingerprint.webgl.unmaskedVendor, "Google Inc. (Apple)");
  assert.match(fingerprint.webgl.unmaskedRenderer, /ANGLE Metal Renderer: Apple M3/);
  assert.equal(fingerprint.locale.timeZone, "Asia/Shanghai");
  assert.equal(fingerprint.locale.locale, "zh-CN");
  assert.equal(fingerprint.window.devicePixelRatio, 2);
  assert.equal(fingerprint.screen.colorDepth, 30);
  assert.equal(fingerprint.screen.pixelDepth, 30);
  assert.match(fingerprint.canvasSignature, /^[0-9a-f]{8}$/);
  assert.equal(fingerprint.webgl2.unmaskedVendor, "Google Inc. (Apple)");
  assert.equal(fingerprint.audio.error, undefined);
  assert.equal(fingerprint.audio.state, "suspended");
  assert.equal(fingerprint.codecs.h264, "probably");
  assert.equal(fingerprint.features.gpu, true);
  assert.equal(fingerprint.features.sharedArrayBuffer, "undefined");
}

function browserAuditSource(taskName, pagePort, expression) {
  return `
const task = await useOrCreateTaskSpace(${JSON.stringify(taskName)})
await openOrReuseTab('http://127.0.0.1:${pagePort}/main', { wait: true, timeout: 20 })
await wait(0.4)
const probeExpression = ${JSON.stringify(expression)}
const rootFingerprint = await js(probeExpression)
const targets = await cdp('Target.getTargets')
const frame = targets.targetInfos.find(target => target.type === 'iframe' && target.url.includes('/frame'))
if (!frame) throw new Error('cross-origin fingerprint frame was not exposed: ' + JSON.stringify(targets.targetInfos))
const attached = await cdp('Target.attachToTarget', { targetId: frame.targetId, flatten: true })
const evaluated = await cdp('Runtime.evaluate', { expression: probeExpression, returnByValue: true, awaitPromise: true }, attached.sessionId)
if (evaluated.exceptionDetails) throw new Error('frame fingerprint failed: ' + JSON.stringify(evaluated.exceptionDetails))
const payload = JSON.stringify({ taskId: task.id, page: await pageInfo(), root: rootFingerprint, frame: evaluated.result.value })
for (let offset = 0; offset < payload.length; offset += 12000) {
  cliLog('__X_BROWSER_FP_CHUNK__' + payload.slice(offset, offset + 12000))
}
`;
}

function continuationAuditSource(taskId, expression) {
  return `
const task = await useOrCreateTaskSpace(${Number(taskId)})
const probeExpression = ${JSON.stringify(expression)}
const rootFingerprint = await js(probeExpression)
const targets = await cdp('Target.getTargets')
const frame = targets.targetInfos.find(target => target.type === 'iframe' && target.url.includes('/frame'))
if (!frame) throw new Error('cross-origin fingerprint frame was not exposed: ' + JSON.stringify(targets.targetInfos))
const attached = await cdp('Target.attachToTarget', { targetId: frame.targetId, flatten: true })
const evaluated = await cdp('Runtime.evaluate', { expression: probeExpression, returnByValue: true, awaitPromise: true }, attached.sessionId)
if (evaluated.exceptionDetails) throw new Error('frame fingerprint failed: ' + JSON.stringify(evaluated.exceptionDetails))
const payload = JSON.stringify({ taskId: task.id, page: await pageInfo(), root: rootFingerprint, frame: evaluated.result.value })
for (let offset = 0; offset < payload.length; offset += 12000) {
  cliLog('__X_BROWSER_FP_CHUNK__' + payload.slice(offset, offset + 12000))
}
`;
}

async function runBrowserAudit(runner, taskName, pagePort, label) {
  const core = parseAuditOutput(
    await runner(browserAuditSource(taskName, pagePort, coreProbeExpression)),
    `${label} core`,
  );
  const graphics = parseAuditOutput(
    await runner(continuationAuditSource(core.taskId, graphicsProbeExpression)),
    `${label} graphics`,
  );
  return {
    taskId: core.taskId,
    page: graphics.page || core.page,
    root: { ...core.root, ...graphics.root },
    frame: { ...core.frame, ...graphics.frame },
  };
}

function fingerprintDifferences(expected, actual, path = "") {
  if (Object.is(expected, actual)) return [];
  if (
    expected === null ||
    actual === null ||
    typeof expected !== "object" ||
    typeof actual !== "object"
  ) {
    return [{ path: path || "$", ego: expected, xBrowser: actual }];
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const differences = [];
  for (const key of [...keys].sort()) {
    differences.push(
      ...fingerprintDifferences(
        expected[key],
        actual[key],
        path ? `${path}.${key}` : key,
      ),
    );
  }
  return differences;
}

function isAllowedFingerprintDifference(path) {
  return (
    path.startsWith("navigator.connection.") ||
    path === "navigator.uaData.high.uaFullVersion" ||
    /^navigator\.uaData\.high\.fullVersionList\.\d+\.version$/.test(path) ||
    path === "window.innerHeight" ||
    path === "window.outerHeight" ||
    path === "window.visualViewport.height"
  );
}

function pick(source, keys) {
  return Object.fromEntries(keys.map((key) => [key, source[key]]));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

function parseAuditOutput(output, label) {
  const marker = "__X_BROWSER_FP_CHUNK__";
  const chunked = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(marker))
    .map((line) => line.slice(marker.length))
    .join("");
  const payload = chunked || output;
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new Error(
      `${label} fingerprint output was not valid JSON (${output.length} chars, ` +
        `${payload.length} payload chars): ` +
        `${JSON.stringify(output.slice(0, 240))} … ${JSON.stringify(output.slice(-240))}; ` +
        String(error),
    );
  }
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
      await new Promise((resolve) => setTimeout(resolve, 100));
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

function runCli(source) {
  return runProcess(join(root, "dist/bin/x-browser"), ["nodejs"], source);
}

function runEgoCli(source) {
  return runProcess("ego-browser", ["nodejs"], source, "stderr");
}

function runProcess(command, args, stdin = "", outputStream = "stdout") {
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
      if (code === 0) {
        resolve((outputStream === "stderr" ? stderr : stdout).trim());
      }
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
    child.stdin.end(stdin);
  });
}
