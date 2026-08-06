import { contextBridge, ipcRenderer } from "electron";

installChromiumBridge();

const HOST_ID = "__x_browser_agent_overlay";
let currentState: any = { controlled: false, presented: false };
let overlayHost: HTMLElement | undefined;
let rootObserver: MutationObserver | undefined;
let hostObserver: MutationObserver | undefined;
let repairFrame = 0;
let overlayName: HTMLElement | undefined;
let overlayMeta: HTMLElement | undefined;
let overlayPointer: HTMLElement | undefined;
let overlayPointerLabel: HTMLElement | undefined;
let pointerTimer: ReturnType<typeof setTimeout> | undefined;

if ((process as any).isMainFrame !== false) installAgentOverlay();

function installAgentOverlay() {
  ipcRenderer.on("x-browser:page-control-state", (_event, state) => {
    currentState = state;
    syncOverlay();
  });
  ipcRenderer.on("x-browser:page-agent-pointer", (_event, state) => {
    showAgentPointer(state);
  });

  void ipcRenderer.invoke("x-browser:page-control-state").then((state) => {
    currentState = state;
    syncOverlay();
  });
}

function syncOverlay() {
  if (!document.documentElement) {
    requestAnimationFrame(syncOverlay);
    return;
  }
  const existing = overlayHost?.isConnected ? overlayHost : undefined;
  if (!currentState?.controlled || !currentState?.presented) {
    overlayHost?.remove();
    overlayHost = undefined;
    overlayName = undefined;
    overlayMeta = undefined;
    overlayPointer = undefined;
    overlayPointerLabel = undefined;
    if (pointerTimer) clearTimeout(pointerTimer);
    pointerTimer = undefined;
    rootObserver?.disconnect();
    hostObserver?.disconnect();
    rootObserver = undefined;
    hostObserver = undefined;
    if (repairFrame) cancelAnimationFrame(repairFrame);
    repairFrame = 0;
    return;
  }
  if (existing) {
    protectOverlayHost(existing);
    syncOverlayContent();
    return;
  }

  const collision = document.getElementById(HOST_ID);
  if (collision) collision.id = `${HOST_ID}_page`;

  const host = document.createElement("div");
  overlayHost = host;
  host.id = HOST_ID;
  host.setAttribute("role", "presentation");
  protectOverlayHost(host);
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .veil {
      position: fixed; inset: 0; overflow: hidden; pointer-events: none;
      contain: strict;
      background:
        radial-gradient(circle, rgba(238, 243, 255, .62) 0 .72px, transparent .92px) 0 0 / 8px 8px,
        radial-gradient(ellipse at 50% 112%, rgba(107, 139, 255, .31), transparent 54%),
        radial-gradient(ellipse at -5% 58%, rgba(74, 119, 255, .29), transparent 34%),
        radial-gradient(ellipse at 105% 56%, rgba(87, 127, 255, .27), transparent 34%),
        linear-gradient(180deg, rgba(9, 12, 18, .28), rgba(7, 10, 17, .44));
      box-shadow:
        inset 0 0 0 1px rgba(212, 224, 255, .3),
        inset 0 0 72px rgba(77, 118, 255, .18);
    }
    .veil::before {
      content: ''; position: absolute; left: -46vw; top: -15%; width: 42vw; height: 130%;
      background: linear-gradient(102deg, transparent 12%, rgba(214, 225, 255, .04) 28%, rgba(230, 237, 255, .24) 50%, rgba(196, 215, 255, .06) 72%, transparent 88%);
      opacity: .66; transform: translate3d(0, 0, 0) skewX(-8deg);
      will-change: transform, opacity;
      animation: ambient-sweep 6.8s cubic-bezier(.45,0,.2,1) infinite;
    }
    .veil::after {
      content: ''; position: absolute; inset: -12%;
      background:
        radial-gradient(ellipse at 50% 105%, rgba(156, 178, 255, .22), transparent 48%),
        radial-gradient(ellipse at 0% 55%, rgba(105, 143, 255, .18), transparent 31%),
        radial-gradient(ellipse at 100% 55%, rgba(105, 143, 255, .16), transparent 31%);
      opacity: .38;
      will-change: opacity;
      animation: ambient-breathe 4.8s ease-in-out infinite;
    }
    .bar {
      position: fixed; left: 50%; bottom: 24px; transform: translate3d(-50%, 0, 0);
      display: flex; align-items: center; gap: 11px; width: min(486px, calc(100vw - 36px));
      min-height: 64px; box-sizing: border-box;
      padding: 9px 10px 9px 12px; border: 1px solid rgba(255,255,255,.09);
      border-radius: 24px; background: rgba(15, 18, 25, .965);
      box-shadow: 0 24px 64px rgba(0, 0, 0, .42), 0 1px 0 rgba(255,255,255,.075) inset;
      color: rgba(250,252,255,.98); font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
      pointer-events: auto;
      animation: bar-in .3s cubic-bezier(.16,1,.3,1) both;
      -webkit-font-smoothing: antialiased;
    }
    .pause-mark {
      display: flex; align-items: center; justify-content: center; gap: 3px;
      width: 13px; height: 30px; flex: 0 0 auto; opacity: .56;
    }
    .pause-mark::before, .pause-mark::after {
      content: ''; width: 2px; height: 10px; border-radius: 999px; background: rgba(225,231,244,.82);
    }
    .agent-mark {
      position: relative; width: 34px; height: 34px; flex: 0 0 auto; display: grid; place-items: center;
      border-radius: 12px; background: radial-gradient(circle at 50% 52%, rgba(94,224,188,.2), transparent 68%);
    }
    .agent-mark::before {
      content: ''; position: absolute; inset: 7px;
      background: conic-gradient(from 0deg, transparent 0 7%, rgba(230,255,248,.96) 8% 12%, transparent 13% 24%, rgba(230,255,248,.82) 25% 29%, transparent 30% 41%, rgba(230,255,248,.96) 42% 46%, transparent 47% 58%, rgba(230,255,248,.82) 59% 63%, transparent 64% 75%, rgba(230,255,248,.96) 76% 80%, transparent 81% 92%, rgba(230,255,248,.82) 93% 97%, transparent 98%);
      border-radius: 50%;
      -webkit-mask: radial-gradient(circle, transparent 0 3px, #000 3.5px);
      mask: radial-gradient(circle, transparent 0 3px, #000 3.5px);
      will-change: transform;
      animation: agent-orbit 3.6s linear infinite;
    }
    .agent-mark::after { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #c9fff0; box-shadow: 0 0 0 5px rgba(85,211,177,.1), 0 0 16px rgba(104,242,205,.42); }
    .copy { flex: 1; min-width: 0; }
    .name { color: rgba(255,255,255,.98); font-size: 14px; font-weight: 650; letter-spacing: -.012em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta { color: rgba(219,225,238,.78); font-size: 11px; font-weight: 560; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    button {
      min-height: 38px; border: 1px solid rgba(255,255,255,.055); border-radius: 13px; padding: 0 14px;
      color: inherit; background: rgba(255,255,255,.045); font: 620 12px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
      cursor: pointer; -webkit-font-smoothing: antialiased;
      transition: transform .18s cubic-bezier(.16,1,.3,1), background .18s ease, border-color .18s ease;
    }
    button:hover { background: rgba(255,255,255,.085); border-color: rgba(255,255,255,.09); }
    button:active { transform: scale(.965); }
    .take { color: rgba(246,248,252,.96); }
    .stop { background: rgba(255,255,255,.035); color: #ff674f; }
    .stop:hover { background: rgba(255,94,72,.1); border-color: rgba(255,94,72,.12); color: #ff7864; }
    .agent-pointer { position: fixed; left: 0; top: 0; z-index: 2; display: flex; align-items: center; gap: 6px; opacity: 0; transform: translate3d(var(--x, 0px), var(--y, 0px), 0); transition: transform .18s cubic-bezier(.2,.8,.2,1), opacity .14s ease; pointer-events: none; }
    .agent-pointer.visible { opacity: 1; }
    .agent-pointer svg { width: 18px; height: 22px; overflow: visible; filter: drop-shadow(0 2px 3px rgba(0,0,0,.3)); }
    .agent-pointer path { fill: rgba(255,255,255,.96); stroke: rgba(31,38,40,.9); stroke-width: 1.2; stroke-linejoin: round; }
    .pointer-label { max-width: 210px; padding: 8px 11px; border: 1px solid rgba(35,41,52,.1); border-radius: 13px; background: rgba(247,248,251,.98); box-shadow: 0 12px 30px rgba(4,8,18,.25); color: #262b35; font: 620 11px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @keyframes ambient-sweep {
      0% { transform: translate3d(0,0,0) skewX(-8deg); opacity: .22; }
      42%,58% { opacity: .78; }
      100% { transform: translate3d(192vw,0,0) skewX(-8deg); opacity: .22; }
    }
    @keyframes ambient-breathe { 0%,100% { opacity: .28; } 50% { opacity: .58; } }
    @keyframes agent-orbit { to { transform: rotate(360deg); } }
    @keyframes bar-in { from { opacity: 0; transform: translate3d(-50%, 10px, 0) scale(.975); } }
    @media (max-width: 620px) {
      .bar { width: calc(100vw - 24px); bottom: 12px; border-radius: 20px; padding-left: 10px; gap: 8px; }
      .pause-mark { display: none; }
      .agent-mark { width: 30px; height: 30px; }
      button { padding: 0 11px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .veil::before, .veil::after, .bar, .agent-mark::before, .agent-pointer { animation: none; transition-duration: .001ms; }
      .veil::before { left: 29%; transform: skewX(-8deg); opacity: .42; }
      .veil::after { opacity: .4; }
    }
  `;
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Agent 正在控制此 Space");
  const pause = document.createElement("span");
  pause.className = "pause-mark";
  pause.setAttribute("aria-hidden", "true");
  const mark = document.createElement("span");
  mark.className = "agent-mark";
  const copy = document.createElement("div");
  copy.className = "copy";
  const name = document.createElement("div");
  name.className = "name";
  overlayName = name;
  const meta = document.createElement("div");
  meta.className = "meta";
  overlayMeta = meta;
  copy.append(name, meta);
  const take = document.createElement("button");
  take.type = "button";
  take.className = "take";
  take.textContent = "接管";
  take.setAttribute("aria-label", "接管此 Space");
  take.addEventListener("click", (event) => {
    event.stopPropagation();
    void ipcRenderer.invoke("x-browser:page:take-over");
  });
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "stop";
  stop.textContent = "终止任务";
  stop.setAttribute("aria-label", "终止 Agent 任务");
  stop.addEventListener("click", (event) => {
    event.stopPropagation();
    void ipcRenderer.invoke("x-browser:page:complete");
  });
  bar.append(pause, mark, copy, take, stop);
  const pointer = document.createElement("div");
  pointer.className = "agent-pointer";
  pointer.innerHTML = `<svg viewBox="0 0 18 22" aria-hidden="true"><path d="M2 1.5v16.2l4.3-4 3.2 6.7 3-1.45-3.15-6.55 5.65-.25L2 1.5Z"></path></svg>`;
  const pointerLabel = document.createElement("span");
  pointerLabel.className = "pointer-label";
  pointer.append(pointerLabel);
  overlayPointer = pointer;
  overlayPointerLabel = pointerLabel;
  const veil = document.createElement("div");
  veil.className = "veil";
  shadow.append(style, veil, pointer, bar);
  document.documentElement.append(host);
  syncOverlayContent();

  rootObserver?.disconnect();
  hostObserver?.disconnect();
  rootObserver = new MutationObserver(scheduleOverlayRepair);
  rootObserver.observe(document.documentElement, { childList: true });
  hostObserver = new MutationObserver(scheduleOverlayRepair);
  hostObserver.observe(host, {
    attributes: true,
    attributeFilter: ["id", "class", "style", "hidden"],
  });
}

function syncOverlayContent() {
  if (overlayName) overlayName.textContent = currentState.name || "Browser Agent";
  if (overlayMeta) {
    overlayMeta.textContent = currentState.task?.detail || "Agent 正在控制";
  }
}

function showAgentPointer(state: any) {
  if (!currentState?.controlled || !currentState?.presented) return;
  syncOverlay();
  const pointer = overlayPointer;
  if (!pointer) {
    requestAnimationFrame(() => showAgentPointer(state));
    return;
  }
  const rawX = Math.max(8, Number(state?.x) || 0);
  const rawY = Math.max(8, Number(state?.y) || 0);
  const x = innerWidth > 40 ? Math.min(innerWidth - 30, rawX) : rawX;
  const y = innerHeight > 44 ? Math.min(innerHeight - 34, rawY) : rawY;
  pointer.style.setProperty("--x", `${x}px`);
  pointer.style.setProperty("--y", `${y}px`);
  if (overlayPointerLabel) {
    overlayPointerLabel.textContent =
      String(state?.label || currentState.task?.detail || "正在浏览网页").slice(0, 80);
  }
  pointer.classList.add("visible");
  if (pointerTimer) clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => {
    pointer.classList.remove("visible");
    pointerTimer = undefined;
  }, 1400);
}

function scheduleOverlayRepair() {
  if (!currentState?.controlled || !currentState?.presented || repairFrame) return;
  repairFrame = requestAnimationFrame(() => {
    repairFrame = 0;
    const host = overlayHost;
    if (!host?.isConnected) {
      overlayHost = undefined;
      syncOverlay();
      return;
    }
    protectOverlayHost(host);
  });
}

function protectOverlayHost(host: HTMLElement) {
  if (host.id !== HOST_ID) host.id = HOST_ID;
  host.dataset.overlayDesign = "agent-dot-matrix-v2";
  host.dataset.overlayMotion = "ambient-sweep-v1";
  host.removeAttribute("hidden");
  const criticalStyles: Record<string, string> = {
    position: "fixed",
    inset: "0px",
    display: "block",
    visibility: "visible",
    opacity: "1",
    transform: "none",
    filter: "none",
    "z-index": "2147483647",
    "pointer-events": "none",
    background: "transparent",
    "box-shadow": "none",
    contain: "layout style paint",
    "-webkit-backdrop-filter": "none",
    "backdrop-filter": "none",
  };
  for (const [property, value] of Object.entries(criticalStyles)) {
    if (
      host.style.getPropertyValue(property) === value &&
      host.style.getPropertyPriority(property) === "important"
    ) {
      continue;
    }
    host.style.setProperty(property, value, "important");
  }
}

function installChromiumBridge() {
  try {
    contextBridge.executeInMainWorld({
      func: installChromiumCompatibility,
    });
    contextBridge.executeInMainWorld({
      func: installFingerprintCompatibility,
    });
  } catch {
    contextBridge.exposeInMainWorld("chrome", createChromiumCompatibilityApi());
  }
}

function createChromiumCompatibilityApi() {
  const navigation = () =>
    performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
  const epochSeconds = (milliseconds: number) =>
    (performance.timeOrigin + milliseconds) / 1000;
  const protocol = () => navigation()?.nextHopProtocol || "unknown";
  const navigationType = () => {
    const type = navigation()?.type;
    if (type === "reload") return "Reload";
    if (type === "back_forward") return "BackForward";
    return "Other";
  };
  const firstPaint = () =>
    performance.getEntriesByName("first-paint")[0]?.startTime ||
    navigation()?.responseStart ||
    0;
  const InstallState = {
    DISABLED: "disabled",
    INSTALLED: "installed",
    NOT_INSTALLED: "not_installed",
  };
  const RunningState = {
    CANNOT_RUN: "cannot_run",
    READY_TO_RUN: "ready_to_run",
    RUNNING: "running",
  };

  return {
    loadTimes() {
      const nav = navigation();
      const negotiated = protocol();
      return {
        requestTime: epochSeconds(nav?.requestStart || 0),
        startLoadTime: epochSeconds(nav?.startTime || 0),
        commitLoadTime: epochSeconds(nav?.responseStart || 0),
        finishDocumentLoadTime: epochSeconds(
          nav?.domContentLoadedEventEnd || nav?.responseEnd || 0,
        ),
        finishLoadTime: epochSeconds(nav?.loadEventEnd || nav?.responseEnd || 0),
        firstPaintTime: epochSeconds(firstPaint()),
        firstPaintAfterLoadTime: 0,
        navigationType: navigationType(),
        wasFetchedViaSpdy: /^(h2|h3|quic)/i.test(negotiated),
        wasNpnNegotiated: negotiated !== "unknown",
        npnNegotiatedProtocol: negotiated,
        wasAlternateProtocolAvailable: false,
        connectionInfo: negotiated,
      };
    },
    csi() {
      const nav = navigation();
      const startE = Math.round(performance.timeOrigin + (nav?.startTime || 0));
      return {
        startE,
        onloadT: Math.round(
          performance.timeOrigin +
            (nav?.domContentLoadedEventEnd || nav?.responseEnd || 0),
        ),
        pageT: Date.now() - startE,
        tran: 15,
      };
    },
    app: {
      isInstalled: false,
      getDetails() {
        return null;
      },
      getIsInstalled() {
        return false;
      },
      installState(callback?: (state: string) => void) {
        callback?.(InstallState.NOT_INSTALLED);
      },
      runningState() {
        return RunningState.CANNOT_RUN;
      },
      InstallState,
      RunningState,
    },
  };
}

function installChromiumCompatibility() {
  const browserWindow = window as any;
  const target = (browserWindow.chrome ||= {});
  const navigation = () =>
    performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const epochSeconds = (milliseconds: number) =>
    (performance.timeOrigin + milliseconds) / 1000;
  const protocol = () => navigation()?.nextHopProtocol || "unknown";
  const navigationType = () => {
    const type = navigation()?.type;
    if (type === "reload") return "Reload";
    if (type === "back_forward") return "BackForward";
    return "Other";
  };
  const firstPaint = () =>
    (performance.getEntriesByName("first-paint")[0]?.startTime ||
      navigation()?.responseStart ||
      0);

  if (typeof target.loadTimes !== "function") {
    target.loadTimes = () => {
      const nav = navigation();
      const negotiated = protocol();
      return {
        requestTime: epochSeconds(nav?.requestStart || 0),
        startLoadTime: epochSeconds(nav?.startTime || 0),
        commitLoadTime: epochSeconds(nav?.responseStart || 0),
        finishDocumentLoadTime: epochSeconds(
          nav?.domContentLoadedEventEnd || nav?.responseEnd || 0,
        ),
        finishLoadTime: epochSeconds(nav?.loadEventEnd || nav?.responseEnd || 0),
        firstPaintTime: epochSeconds(firstPaint()),
        firstPaintAfterLoadTime: 0,
        navigationType: navigationType(),
        wasFetchedViaSpdy: /^(h2|h3|quic)/i.test(negotiated),
        wasNpnNegotiated: negotiated !== "unknown",
        npnNegotiatedProtocol: negotiated,
        wasAlternateProtocolAvailable: false,
        connectionInfo: negotiated,
      };
    };
  }
  if (typeof target.csi !== "function") {
    target.csi = () => {
      const nav = navigation();
      const startE = Math.round(performance.timeOrigin + (nav?.startTime || 0));
      return {
        startE,
        onloadT: Math.round(
          performance.timeOrigin +
            (nav?.domContentLoadedEventEnd || nav?.responseEnd || 0),
        ),
        pageT: Date.now() - startE,
        tran: 15,
      };
    };
  }
  if (!target.app) {
    const InstallState = {
      DISABLED: "disabled",
      INSTALLED: "installed",
      NOT_INSTALLED: "not_installed",
    };
    const RunningState = {
      CANNOT_RUN: "cannot_run",
      READY_TO_RUN: "ready_to_run",
      RUNNING: "running",
    };
    target.app = {
      isInstalled: false,
      getDetails: () => null,
      getIsInstalled: () => false,
      installState: (callback?: (state: string) => void) =>
        callback?.(InstallState.NOT_INSTALLED),
      runningState: () => RunningState.CANNOT_RUN,
      InstallState,
      RunningState,
    } as any;
  }
}

function installFingerprintCompatibility() {
  const browserWindow = window as any;
  const nativeFunctionToString = Function.prototype.toString;
  const nativeStrings = new WeakMap<Function, string>();
  const functionToString = new Proxy(nativeFunctionToString, {
    apply(target, thisArg, args) {
      if (typeof thisArg === "function") {
        const source = nativeStrings.get(thisArg);
        if (source) return source;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      Function.prototype,
      "toString",
    );
    if (descriptor?.configurable) {
      nativeStrings.set(
        functionToString,
        "function toString() { [native code] }",
      );
      Object.defineProperty(Function.prototype, "toString", {
        ...descriptor,
        value: functionToString,
      });
    }
  } catch {
    // Function source masking is best-effort.
  }
  const markNative = (value: unknown, source: string) => {
    if (typeof value === "function") nativeStrings.set(value, source);
  };

  try {
    const audioPrototype = browserWindow.AudioContext?.prototype;
    const basePrototype = browserWindow.BaseAudioContext?.prototype;
    const descriptor = basePrototype
      ? Object.getOwnPropertyDescriptor(basePrototype, "state")
      : undefined;
    if (audioPrototype && descriptor?.get && descriptor.configurable) {
      const nativeState = descriptor.get;
      const state = new Proxy(nativeState, {
        apply(target, thisArg, args) {
          const value = Reflect.apply(target, thisArg, args);
          // Electron exposes a fresh real-time context as running even under
          // Chromium's autoplay switch. Regular Chrome/Ego keeps it suspended
          // until a user activation, so preserve that observable state here.
          if (
            value === "running" &&
            thisArg instanceof browserWindow.AudioContext &&
            !navigator.userActivation.hasBeenActive
          ) {
            return "suspended";
          }
          return value;
        },
      });
      Object.defineProperty(basePrototype, "state", {
        ...descriptor,
        get: state,
      });
      markNative(state, "function get state() { [native code] }");
    }
  } catch {
    // Preserve Chromium's native Web Audio surface when it is sealed.
  }

  markNative(browserWindow.chrome?.loadTimes, "function () { [native code] }");
  markNative(browserWindow.chrome?.csi, "function () { [native code] }");
  for (const name of [
    "getDetails",
    "getIsInstalled",
    "installState",
    "runningState",
  ]) {
    markNative(
      browserWindow.chrome?.app?.[name],
      `function ${name}() { [native code] }`,
    );
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(window, "chrome");
    if (descriptor?.configurable) {
      Object.defineProperty(window, "chrome", {
        ...descriptor,
        configurable: false,
      });
    }
  } catch {
    // Preserve the native descriptor if Chromium seals it first.
  }

  const exactLanguages = Object.freeze(["zh-CN", "zh"]);
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      Navigator.prototype,
      "languages",
    );
    if (descriptor?.get && descriptor.configurable) {
      const getter = new Proxy(descriptor.get, {
        apply: () => exactLanguages,
      });
      Object.defineProperty(Navigator.prototype, "languages", {
        ...descriptor,
        get: getter,
      });
      markNative(getter, "function get languages() { [native code] }");
    }
  } catch {
    // Preserve the native surface when Chromium makes it non-configurable.
  }

  try {
    const permissionsPrototype = Object.getPrototypeOf(navigator.permissions);
    const descriptor = permissionsPrototype
      ? Object.getOwnPropertyDescriptor(permissionsPrototype, "query")
      : undefined;
    if (descriptor?.value && descriptor.configurable) {
      const nativeQuery = descriptor.value;
      const topLevelStates = new Map<string, PermissionState>([
        ["geolocation", "prompt"],
        ["notifications", "prompt"],
        ["camera", "prompt"],
        ["microphone", "prompt"],
        ["clipboard-read", "prompt"],
        ["clipboard-write", "granted"],
        ["midi", "prompt"],
        ["persistent-storage", "prompt"],
        ["payment-handler", "granted"],
        ["window-management", "prompt"],
        ["local-fonts", "prompt"],
      ]);
      const frameStates = new Map<string, PermissionState>([
        ["persistent-storage", "prompt"],
        ["payment-handler", "granted"],
      ]);
      const query = new Proxy(nativeQuery, {
        apply: async (target, thisArg, args) => {
          const status: any = await Reflect.apply(target, thisArg, args);
          const name = String(args?.[0]?.name || "");
          const state =
            window.top === window
              ? topLevelStates.get(name)
              : frameStates.get(name) ?? "denied";
          if (!state || status?.state === state) return status;
          return new Proxy(status as object, {
            get(permissionStatus, property) {
              if (property === "state") return state;
              const value = Reflect.get(
                permissionStatus,
                property,
                permissionStatus,
              );
              return typeof value === "function"
                ? value.bind(permissionStatus)
                : value;
            },
            set(permissionStatus, property, value) {
              return Reflect.set(
                permissionStatus,
                property,
                value,
                permissionStatus,
              );
            },
          });
        },
      });
      Object.defineProperty(permissionsPrototype, "query", {
        ...descriptor,
        value: query,
      });
      markNative(query, "function query() { [native code] }");
    }
  } catch {
    // Permissions remain functional even if Chromium seals the API first.
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      Notification,
      "permission",
    );
    if (descriptor?.get && descriptor.configurable) {
      const permission = new Proxy(descriptor.get, {
        apply: () => (window.top === window ? "default" : "denied"),
      });
      Object.defineProperty(Notification, "permission", {
        ...descriptor,
        get: permission,
      });
      markNative(permission, "function get permission() { [native code] }");
    }
  } catch {
    // Preserve the native Notification surface when it is sealed.
  }

  try {
    const storagePrototype = Object.getPrototypeOf(navigator.storage);
    const descriptor = storagePrototype
      ? Object.getOwnPropertyDescriptor(storagePrototype, "estimate")
      : undefined;
    if (descriptor?.value && descriptor.configurable) {
      const nativeEstimate = descriptor.value;
      const estimate = new Proxy(nativeEstimate, {
        apply: async (target, thisArg, args) => {
          const result: any = await Reflect.apply(target, thisArg, args);
          return {
            ...result,
            quota: Math.min(
              Number(result?.quota) || 10 * 1024 ** 3,
              10 * 1024 ** 3,
            ),
          };
        },
      });
      Object.defineProperty(storagePrototype, "estimate", {
        ...descriptor,
        value: estimate,
      });
      markNative(estimate, "function estimate() { [native code] }");
    }
  } catch {
    // Fall back to Chromium's native quota estimate.
  }
}
