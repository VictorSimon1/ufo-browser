/**
 * "ego lite has an update" hint for the agent-facing runtime.
 *
 * Loosely modeled on lark cli's `_notice` — surface one tagged line telling the
 * agent a newer ego lite exists — but deliberately WITHOUT lark's cache. lark
 * persists a throttled state file because every check is an HTTP round-trip to
 * npm, an expensive cost worth amortizing. Our source is `ego.getBrowserVersion()`:
 * a cheap local bridge call into the app, whose updater already knows
 * `updateAvailable`. There is no cost to amortize and nothing to persist, so every
 * command just asks directly and the answer is always current. (Don't re-add a
 * cache; it would only reintroduce staleness this version exists to avoid.)
 *
 * The version source is injected — in production `installEgoSdk` builds it from the
 * app's `ego` bridge. On older app builds without `getBrowserVersion`, that source
 * yields null and the check degrades to "no update". The remedy is *not* a symmetric
 * `ego.upgradeBrowser()` bridge call — the app exposes that half as the native CLI
 * subcommand `ego-browser upgrade`, so the composed line tells the agent to run it as
 * a shell command.
 *
 * `emitUpdateNotice` never writes output itself: it hands the resolved line to a
 * caller-supplied `emit`, so the caller owns the channel and timing. The SDK path
 * registers it as an output-sink trailer, so the hint is appended after the command's
 * own output instead of racing ahead of it. The whole module is pure given an injected
 * version source, so it is exercised without a real browser.
 */

/** Raw shape the client `ego.getBrowserVersion()` is expected to return. */
export type BrowserVersionInfo = {
  currentVersion: string;
  updateAvailable: boolean;
  latestVersion?: string;
  mandatory?: boolean;
};

/** The injectable seam for the client version query. */
export type VersionSource = () => Promise<
  BrowserVersionInfo | null | undefined
>;

/** Prefix that marks the appended line as out-of-band, not real command output. */
export const NOTICE_PREFIX = "[ego-browser:notice]";

/** Upper bound on how long the version probe may run before the check gives up. */
export const NOTICE_PROBE_TIMEOUT_MS = 2000;

/**
 * Suppress the hint entirely. Mirrors lark's opt-out (`*_NO_UPDATE_NOTIFIER`) and
 * stays quiet in CI, where a nag line is noise no one acts on.
 */
export function noticeSuppressed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.EGO_BROWSER_NO_UPDATE_NOTIFIER || env.CI);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Format the version info into one line, or null when there is nothing to say.
 *
 * This is the single boundary check on the bridge's return: the source crosses a
 * runtime seam (an injected app method), so every field is validated to its declared
 * type here. `updateAvailable`/`mandatory` must be the literal boolean `true` — a
 * truthy non-boolean (e.g. the string "false") does not count — and the version
 * strings must be non-blank, so a missing/empty `currentVersion` yields null and a
 * missing/empty `latestVersion` degrades to the generic phrase.
 */
export function composeNotice(
  info: BrowserVersionInfo | null | undefined,
): string | null {
  if (
    !info ||
    info.updateAvailable !== true ||
    !isNonEmptyString(info.currentVersion)
  ) {
    return null;
  }
  const target = isNonEmptyString(info.latestVersion)
    ? `ego lite ${info.latestVersion}`
    : "an ego lite update";
  const urgency = info.mandatory === true ? "is required" : "is available";
  return `${NOTICE_PREFIX} ${target} ${urgency} (current ${info.currentVersion}) — run: ego-browser upgrade in your shell, then re-read the ego-browser skill`;
}

/**
 * Race a promise against a timeout, resolving to null if the timeout wins. The timer is
 * unref'd so it never keeps the process alive on its own, and it is cleared as soon as
 * the probe settles. This bounds how long the check waits on the bridge: a slow (or
 * stuck) `getBrowserVersion()` can no longer leave the update check pending forever.
 * (It cannot cancel the underlying bridge call — that handle is the app's to release.)
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Ask the injected source (bounded by a timeout) and return the line to append, or null.
 * Swallows every failure: an update check must never be what breaks a command.
 */
export async function updateNoticeLine(options: {
  source: VersionSource;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<string | null> {
  if (noticeSuppressed(options.env || process.env)) return null;
  try {
    const info = await withTimeout(
      Promise.resolve(options.source()),
      options.timeoutMs ?? NOTICE_PROBE_TIMEOUT_MS,
    );
    return composeNotice(info);
  } catch {
    return null;
  }
}

/**
 * The one real entry point: given the app's injected `ego` bridge (or none, on older
 * builds), fire the check and hand the resulting line to `emit`. Fire-and-forget —
 * `installEgoSdk()` calls this without awaiting it, so the check runs concurrently with
 * the rest of the heredoc rather than delaying it. `emit` decides where the line goes
 * and when: the SDK path routes it to the output sink so it is appended after the
 * command's own output.
 *
 * Fully guarded: `updateNoticeLine` never rejects, and the trailing `.catch` covers a
 * throwing `emit`, so neither a failed check nor a failed write can surface as an
 * unhandled rejection that breaks the command.
 */
export function emitUpdateNotice(
  ego: { getBrowserVersion?: VersionSource } | null | undefined,
  emit: (line: string) => void,
  env?: NodeJS.ProcessEnv,
): void {
  updateNoticeLine({
    source: () => ego?.getBrowserVersion?.() ?? Promise.resolve(null),
    env,
  })
    .then((line) => {
      if (line) emit(line);
    })
    .catch(() => {});
}
