import { contextBridge, ipcRenderer } from "electron";

installChromiumBridge();

const HOST_ID = "__x_browser_agent_overlay";
let currentState: any = { controlled: false };
let overlayHost: HTMLElement | undefined;
let rootObserver: MutationObserver | undefined;
let hostObserver: MutationObserver | undefined;
let repairFrame = 0;
let agentInputActive = false;
let overlayName: HTMLElement | undefined;
let overlayMeta: HTMLElement | undefined;
let overlayPointer: HTMLElement | undefined;
let overlayPointerLabel: HTMLElement | undefined;
let pointerTimer: ReturnType<typeof setTimeout> | undefined;

if ((process as any).isMainFrame !== false) installAgentOverlay();

function installAgentOverlay() {
  ipcRenderer.on("x-browser:page-agent-input", (_event, active) => {
    agentInputActive = Boolean(active);
    if (overlayHost?.isConnected) protectOverlayHost(overlayHost);
  });
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
  if (!currentState?.controlled) {
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
      position: fixed; inset: 0; pointer-events: none;
      border: 1px solid rgba(199, 220, 213, .42);
      box-shadow: inset 0 0 0 1px rgba(18, 24, 22, .08);
    }
    .veil::before {
      content: ''; position: absolute; left: 0; top: -1px; width: min(42vw, 620px); height: 2px;
      border-radius: 999px;
      background: linear-gradient(90deg, transparent 0%, rgba(164, 222, 205, .08) 18%, rgba(192, 242, 226, .86) 50%, rgba(164, 222, 205, .08) 82%, transparent 100%);
      opacity: .72; transform: translate3d(-120%, 0, 0);
      will-change: transform, opacity;
      animation: edge-wave 8.4s cubic-bezier(.45,0,.25,1) infinite;
    }
    .bar {
      position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 10px; min-width: 368px; max-width: min(590px, calc(100vw - 28px));
      padding: 8px 8px 8px 12px; border: 1px solid rgba(13, 18, 16, .13);
      border-radius: 17px; background: rgba(247, 249, 248, .965);
      box-shadow: 0 20px 52px rgba(4, 8, 7, .28), 0 1px 0 rgba(255,255,255,.8) inset;
      color: #171b19; font: 500 11px/1.2 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
      pointer-events: auto;
      animation: bar-in .22s cubic-bezier(.2,.8,.2,1) both;
    }
    .agent-mark { position: relative; width: 27px; height: 27px; flex: 0 0 auto; display: grid; place-items: center; }
    .agent-mark::before { content: ''; position: absolute; inset: 2px; border: 1px solid rgba(17,25,22,.2); border-radius: 50%; animation: agent-breathe 2.8s ease-in-out infinite; }
    .agent-mark::after { content: ''; position: absolute; inset: 6px; border: 1px solid rgba(17,25,22,.12); border-radius: 50%; }
    .agent-mark i { width: 6px; height: 6px; border-radius: 50%; background: #2b6758; box-shadow: 0 0 0 4px rgba(69,130,113,.1); }
    .copy { flex: 1; min-width: 0; }
    .name { color: #141816; font-weight: 650; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta { color: #65706c; font-size: 9.5px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    button { border: 1px solid transparent; border-radius: 8px; padding: 6px 9px; color: inherit; font: inherit; cursor: pointer; transition: transform .14s ease, background .14s ease, border-color .14s ease; }
    button:active { transform: scale(.96); }
    .take { border-color: #171b19; background: #171b19; color: #fff; }
    .take:hover { background: #2b302e; border-color: #2b302e; }
    .stop { border-color: rgba(157,51,47,.15); background: rgba(157,51,47,.07); color: #983d39; }
    .stop:hover { background: rgba(157,51,47,.12); color: #7f302d; }
    .agent-pointer { position: fixed; left: 0; top: 0; z-index: 2; display: flex; align-items: center; gap: 6px; opacity: 0; transform: translate3d(var(--x, 0px), var(--y, 0px), 0); transition: transform .18s cubic-bezier(.2,.8,.2,1), opacity .14s ease; pointer-events: none; }
    .agent-pointer.visible { opacity: 1; }
    .agent-pointer svg { width: 18px; height: 22px; overflow: visible; filter: drop-shadow(0 2px 3px rgba(0,0,0,.3)); }
    .agent-pointer path { fill: rgba(255,255,255,.96); stroke: rgba(31,38,40,.9); stroke-width: 1.2; stroke-linejoin: round; }
    .pointer-label { max-width: 190px; padding: 6px 9px; border: 1px solid rgba(64,75,78,.12); border-radius: 11px; background: rgba(255,255,255,.94); box-shadow: 0 10px 25px rgba(21,28,30,.22); color: #30383a; font: 600 10.5px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); }
    @keyframes edge-wave { 0% { transform: translate3d(-120%,0,0); opacity: .18; } 45%,55% { opacity: .82; } 100% { transform: translate3d(calc(100vw + 120%),0,0); opacity: .18; } }
    @keyframes agent-breathe { 0%,100% { transform: scale(.92); opacity: .42; } 50% { transform: scale(1.08); opacity: .9; } }
    @keyframes bar-in { from { opacity: 0; transform: translate(-50%, 8px) scale(.98); } }
    @media (prefers-reduced-motion: reduce) { .veil::before, .bar, .agent-mark::before, .agent-pointer { animation: none; transition-duration: .001ms; } .veil::before { left: 29%; transform: none; opacity: .5; } }
  `;
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Agent 正在控制此 Space");
  const mark = document.createElement("span");
  mark.className = "agent-mark";
  mark.append(document.createElement("i"));
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
  bar.append(mark, copy, take, stop);
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
  if (!currentState?.controlled) return;
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
  if (!currentState?.controlled || repairFrame) return;
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
  host.dataset.overlayDesign = "openai-neutral-v1";
  host.dataset.overlayMotion = "edge-wave";
  host.removeAttribute("hidden");
  const pointerEvents =
    agentInputActive || host.dataset.agentInput === "1" ? "none" : "auto";
  const criticalStyles: Record<string, string> = {
    position: "fixed",
    inset: "0px",
    display: "block",
    visibility: "visible",
    opacity: "1",
    transform: "none",
    filter: "none",
    "z-index": "2147483647",
    "pointer-events": pointerEvents,
    background: "rgba(7, 11, 10, .16)",
    "box-shadow":
      "inset 0 0 0 1px rgba(205, 226, 219, .28)",
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
