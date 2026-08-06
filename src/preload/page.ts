import { contextBridge } from "electron";

installChromiumBridge();

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
