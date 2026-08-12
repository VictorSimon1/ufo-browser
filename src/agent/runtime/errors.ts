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
  recovery: { kind: string; suggestions: string[] };

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
    const kind = details.reason === "intercepted"
      ? "intercepted"
      : details.reason === "detached"
        ? "stale-ref"
        : details.reason === "not-visible"
          ? "not-visible"
          : details.reason === "disabled"
            ? "disabled"
            : "not-ready";
    const suggestions = Array.isArray(details.suggestions)
      ? details.suggestions.map(String)
      : defaultRecoverySuggestions(kind, details.interceptedBy);
    this.recovery = { kind, suggestions };
    if (suggestions.length > 0) {
      this.message = `${this.message}\n- 建议：${suggestions.join("；")}`;
    }
  }

  attachScreenshot(path: string) {
    this.screenshot = path;
    this.message = `${this.message}\n- 最终截图：${path}`;
    return this;
  }
}

function defaultRecoverySuggestions(kind: string, interceptedBy?: string) {
  if (kind === "intercepted") {
    return [
      interceptedBy ? `先检查遮挡元素 ${interceptedBy}` : "先检查当前遮挡元素",
      "如果是弹窗，使用 getByRole('dialog') 定位并关闭或处理",
      "确认目标确实应绕过遮罩后再使用 force: true",
    ];
  }
  if (kind === "stale-ref") {
    return [
      "重新获取 snapshotText() 或 snapshotRaw()",
      "如果匹配多个元素，使用更窄的 locator、first() 或 nth(index)",
    ];
  }
  if (kind === "disabled") return ["等待控件启用，或检查 aria-disabled/disabled 状态"];
  if (kind === "not-visible") return ["等待元素显示，或先滚动到可见区域"];
  return ["重新观察页面状态后重试", "缩小 locator 范围并确认页面已完成导航"];
}
