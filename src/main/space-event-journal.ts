import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SpaceEventCategory =
  | "action"
  | "navigation"
  | "network"
  | "console"
  | "dialog"
  | "download"
  | "lifecycle"
  | "trace";

export type SpaceEvent = {
  sequence: number;
  spaceId: number;
  at: number;
  category: SpaceEventCategory;
  type: string;
  connectionId?: string;
  tabId?: string;
  stepId?: string;
  data?: Record<string, unknown>;
};

export type AppendSpaceEvent = Omit<SpaceEvent, "sequence" | "at" | "data"> & {
  at?: number;
  data?: Record<string, unknown>;
};

export type SpaceEventListOptions = {
  after?: number;
  limit?: number;
  categories?: SpaceEventCategory[];
};

type JournalOptions = {
  directory?: string;
  maxEventsPerSpace?: number;
  maxAgeMs?: number;
  now?: () => number;
};

const FILE_PATTERN = /^space-(\d+)\.json$/;
const META_FILE = "journal-meta.json";
const DEFAULT_MAX_EVENTS = 2_000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|set-cookie|otp|pin|credential|api[-_]?key|card|cvv/i;
const SENSITIVE_TEXT =
  /(bearer\s+[a-z0-9._~+/=-]+|(?:password|secret|token|otp|pin|authorization|cookie)\s*[:=]\s*[^\s,;]+)/gi;

export class SpaceEventJournal {
  private readonly events = new Map<number, SpaceEvent[]>();
  private readonly writeQueues = new Map<number, Promise<void>>();
  private readonly dirtySpaces = new Set<number>();
  private readonly maxEventsPerSpace: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private nextSequence = 1;
  private initialized = false;

  constructor(private readonly options: JournalOptions = {}) {
    this.maxEventsPerSpace = positiveInteger(
      options.maxEventsPerSpace,
      DEFAULT_MAX_EVENTS,
    );
    this.maxAgeMs = positiveInteger(options.maxAgeMs, DEFAULT_MAX_AGE_MS);
    this.now = options.now ?? Date.now;
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.options.directory) return;
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const names = await readdir(this.options.directory).catch(() => [] as string[]);
    const meta = await readJson(join(this.options.directory, META_FILE));
    let maximum = 0;
    for (const name of names) {
      const match = name.match(FILE_PATTERN);
      if (!match) continue;
      const spaceId = Number(match[1]);
      const parsed = await readJson(join(this.options.directory, name));
      if (!Array.isArray(parsed)) continue;
      const restored = parsed
        .filter((event): event is SpaceEvent => validEvent(event, spaceId))
        .map((event) => redactSpaceEvent(event));
      const bounded = this.bound(restored);
      if (bounded.length) this.events.set(spaceId, bounded);
      for (const event of bounded) maximum = Math.max(maximum, event.sequence);
    }
    const persistedNext = Number((meta as any)?.nextSequence);
    this.nextSequence = Math.max(
      maximum + 1,
      Number.isSafeInteger(persistedNext) && persistedNext > 0
        ? persistedNext
        : 1,
    );
  }

  append(input: AppendSpaceEvent) {
    if (!Number.isSafeInteger(input.spaceId) || input.spaceId <= 0) {
      throw new TypeError("SpaceEventJournal requires a positive spaceId");
    }
    const event = redactSpaceEvent({
      ...input,
      sequence: this.nextSequence++,
      at: Number.isFinite(input.at) ? Number(input.at) : this.now(),
    });
    const current = this.events.get(input.spaceId) ?? [];
    current.push(event);
    this.events.set(input.spaceId, this.bound(current));
    this.schedulePersist(input.spaceId);
    return structuredClone(event);
  }

  list(spaceId: number, options: SpaceEventListOptions = {}) {
    const after = nonNegativeInteger(options.after, 0);
    const limit = Math.min(1_000, positiveInteger(options.limit, 200));
    const categories = Array.isArray(options.categories)
      ? new Set(options.categories)
      : undefined;
    const all = this.events.get(spaceId) ?? [];
    const oldestSequence = all[0]?.sequence;
    const selected = all
      .filter(
        (event) =>
          event.sequence > after &&
          (!categories || categories.has(event.category)),
      )
      .slice(0, limit)
      .map((event) => structuredClone(event));
    return {
      events: selected,
      nextSequence: selected.at(-1)?.sequence ?? after,
      cursorExpired:
        after > 0 && oldestSequence !== undefined && after < oldestSequence - 1,
      oldestSequence,
      latestSequence: all.at(-1)?.sequence ?? 0,
    };
  }

  async clear(spaceId: number) {
    this.events.delete(spaceId);
    const pending = this.writeQueues.get(spaceId);
    if (pending) await pending.catch(() => undefined);
    this.writeQueues.delete(spaceId);
    if (this.options.directory) {
      await rm(this.pathFor(spaceId), { force: true }).catch(() => undefined);
    }
  }

  async flush() {
    while (this.writeQueues.size || this.dirtySpaces.size) {
      for (const spaceId of this.dirtySpaces) this.schedulePersist(spaceId);
      await Promise.allSettled([...this.writeQueues.values()]);
    }
  }

  private bound(events: SpaceEvent[]) {
    const cutoff = this.now() - this.maxAgeMs;
    const recent = events.filter((event) => event.at >= cutoff);
    return recent.length > this.maxEventsPerSpace
      ? recent.slice(-this.maxEventsPerSpace)
      : recent;
  }

  private schedulePersist(spaceId: number) {
    if (!this.options.directory) return;
    this.dirtySpaces.add(spaceId);
    if (this.writeQueues.has(spaceId)) return;
    // Action start/finish and their CDP diagnostics arrive in tight bursts.
    // Coalesce them so tracing never turns one browser action into several
    // whole-file rewrites on the event loop's I/O completion path.
    const queued = new Promise<void>((resolve) => setTimeout(resolve, 12)).then(
      async () => {
        while (this.dirtySpaces.delete(spaceId)) {
          await this.persist(spaceId);
        }
      },
    );
    this.writeQueues.set(spaceId, queued);
    void queued
      .finally(() => {
        if (this.writeQueues.get(spaceId) === queued) {
          this.writeQueues.delete(spaceId);
        }
        if (this.dirtySpaces.has(spaceId)) this.schedulePersist(spaceId);
      })
      .catch(() => undefined);
  }

  private async persist(spaceId: number) {
    if (!this.options.directory) return;
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const target = this.pathFor(spaceId);
    const temporary = `${target}.${process.pid}.${spaceId}.tmp`;
    const payload = JSON.stringify(this.events.get(spaceId) ?? []);
    await writeFile(temporary, payload, { mode: 0o600 });
    await rename(temporary, target);
    const metaTarget = join(this.options.directory, META_FILE);
    const metaTemporary = `${metaTarget}.${process.pid}.${spaceId}.tmp`;
    await writeFile(
      metaTemporary,
      JSON.stringify({ nextSequence: this.nextSequence }),
      { mode: 0o600 },
    );
    await rename(metaTemporary, metaTarget);
  }

  private pathFor(spaceId: number) {
    return join(this.options.directory!, `space-${spaceId}.json`);
  }
}

export function redactEventData(value: unknown, key = "", depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const sanitized = sanitizeUrl(value).replace(SENSITIVE_TEXT, "[redacted]");
    return sanitized.length > 4_096 ? `${sanitized.slice(0, 4_096)}…` : sanitized;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactEventData(item, key, depth + 1));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
      const redacted = redactEventData(childValue, childKey, depth + 1);
      if (redacted !== undefined) output[childKey] = redacted;
    }
    return output;
  }
  return String(value);
}

function redactSpaceEvent(event: SpaceEvent): SpaceEvent {
  return {
    ...event,
    data: event.data
      ? (redactEventData(event.data) as Record<string, unknown>)
      : undefined,
  };
}

function sanitizeUrl(value: string) {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    for (const [name] of url.searchParams) {
      if (SENSITIVE_KEY.test(name)) url.searchParams.set(name, "[redacted]");
    }
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function validEvent(value: unknown, spaceId: number): value is SpaceEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<SpaceEvent>;
  return (
    event.spaceId === spaceId &&
    Number.isSafeInteger(event.sequence) &&
    Number(event.sequence) > 0 &&
    Number.isFinite(event.at) &&
    typeof event.category === "string" &&
    typeof event.type === "string"
  );
}

async function readJson(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}
