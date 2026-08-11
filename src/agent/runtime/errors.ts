// @ts-nocheck

export class TimeoutError extends Error {
  timeout: number;
  locator?: string;
  url?: string;
  matchCount?: number;

  constructor(message: string, details: any = {}) {
    super(message);
    this.name = "TimeoutError";
    this.timeout = Number(details.timeout || 0);
    this.locator = details.locator;
    this.url = details.url;
    this.matchCount = details.matchCount;
  }
}

export class ActionabilityError extends Error {
  locator: string;
  reason: string;
  interceptedBy?: string;
  attempts: number;
  callLog: string[];
  screenshot?: string;

  constructor(details: any) {
    const callLog = Array.isArray(details.callLog) ? details.callLog : [];
    super(
      [
        `Action: ${details.operation || "action"}`,
        `Locator: ${details.locator}`,
        `Timeout: ${Number(details.timeout || 0)} ms`,
        "Call log:",
        ...callLog.map((entry) => `- ${entry}`),
      ].join("\n"),
    );
    this.name = "ActionabilityError";
    this.locator = String(details.locator || "");
    this.reason = String(details.reason || "not-ready");
    this.interceptedBy = details.interceptedBy;
    this.attempts = Number(details.attempts || 0);
    this.callLog = callLog;
  }

  attachScreenshot(path: string) {
    this.screenshot = path;
    this.message = `${this.message}\n- 最终截图：${path}`;
    return this;
  }
}
