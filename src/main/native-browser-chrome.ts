import { createRequire } from "node:module";
import type { BaseWindow } from "electron";

export type NativeBrowserChromeEvent =
  | { type: "show-overview" }
  | { type: "new-tab" }
  | { type: "activate-tab"; targetId: string }
  | { type: "close-tab"; targetId: string }
  | { type: "navigate"; value: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" };

type NativeBrowserChromeAddon = {
  installChrome(
    nativeWindowHandle: Buffer,
    callback: (eventJson: string) => void,
  ): boolean;
  updateChrome(stateJson: string): boolean;
  setChromeVisible(visible: boolean): boolean;
  focusChromeAddress(): boolean;
  submitChromeAddressForTest(value: string): boolean;
  captureChrome(): Buffer | null;
  inspectChrome(): string | null;
};

export type NativeBrowserChromeInspection = {
  visible: boolean;
  titlebarDraggable: boolean;
  controlled: boolean;
  controlledTabDraggable: boolean;
  tabCount: number;
  spacesCount: string;
  addressValue: string;
  addressPending: boolean;
  addressFocused: boolean;
  titleHitClass: string;
  addressHitClass: string;
  addressFrame: { x: number; y: number; width: number; height: number };
};

export class NativeBrowserChrome {
  private readonly addon?: NativeBrowserChromeAddon;
  private installed = false;
  private cachedCapture?: Buffer;

  constructor(
    private readonly window: BaseWindow,
    addonPath: string,
  ) {
    if (process.platform !== "darwin") return;
    try {
      const require = createRequire(import.meta.url);
      this.addon = require(addonPath) as NativeBrowserChromeAddon;
    } catch (error) {
      console.warn("Native Browser Chrome is unavailable", error);
    }
  }

  install(listener: (event: NativeBrowserChromeEvent) => void) {
    if (!this.addon) return false;
    try {
      this.installed = this.addon.installChrome(
        this.window.getNativeWindowHandle(),
        (eventJson) => {
          try {
            const event = JSON.parse(eventJson) as NativeBrowserChromeEvent;
            if (!event || typeof event.type !== "string") return;
            listener(event);
          } catch {
            // Ignore malformed native callback payloads.
          }
        },
      );
      return this.installed;
    } catch (error) {
      console.warn("Unable to install native Browser Chrome", error);
      return false;
    }
  }

  isAvailable() {
    return this.installed && Boolean(this.addon);
  }

  update(state: unknown) {
    if (!this.isAvailable()) return false;
    try {
      return Boolean(this.addon?.updateChrome(JSON.stringify(state)));
    } catch {
      return false;
    }
  }

  setVisible(visible: boolean) {
    if (!this.isAvailable()) return false;
    try {
      return Boolean(this.addon?.setChromeVisible(visible));
    } catch {
      return false;
    }
  }

  focusAddress() {
    if (!this.isAvailable()) return false;
    try {
      return Boolean(this.addon?.focusChromeAddress());
    } catch {
      return false;
    }
  }

  submitAddressForTest(value: string) {
    if (!this.isAvailable()) return false;
    try {
      return Boolean(this.addon?.submitChromeAddressForTest(value));
    } catch {
      return false;
    }
  }

  capturePng() {
    if (!this.isAvailable()) return undefined;
    try {
      const png = this.addon?.captureChrome();
      if (!png || png.byteLength === 0) return undefined;
      this.cachedCapture = png;
      return png;
    } catch {
      return undefined;
    }
  }

  cachedPng() {
    return this.cachedCapture;
  }

  inspect() {
    if (!this.isAvailable()) return undefined;
    try {
      const json = this.addon?.inspectChrome();
      return json
        ? (JSON.parse(json) as NativeBrowserChromeInspection)
        : undefined;
    } catch {
      return undefined;
    }
  }
}
