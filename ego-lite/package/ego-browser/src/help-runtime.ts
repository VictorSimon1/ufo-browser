type ParamInfo = {
  name: string;
  type: string | null;
  description: string | null;
  optional: boolean;
  rest: boolean;
  default: string | null;
};

type HelperDoc = {
  name: string;
  signature: string;
  description: string | null;
  params: ParamInfo[];
  returns: string | null;
  async: boolean;
};

// Helper docs are extracted from the bundle at build time and injected here by
// scripts/build.mjs, which replaces the placeholder below with a JSON string.
// The runtime must never introspect its own source: in the shipped browser the
// SDK is loaded from a compiled .pak resource whose import.meta.url is
// "ego://services/node/resources/index.js", which is not a readable file, so
// the previous readFileSync(fileURLToPath(import.meta.url)) approach silently
// produced an empty docs map. See GitHub issue #84.
const EMBEDDED_DOCS_JSON = "__EGO_EMBEDDED_HELP_DOCS__";

let cache: Map<string, HelperDoc> | null = null;

export function help(
  helpers: Record<string, unknown>,
  ...names: string[]
): HelperDoc | HelperDoc[] | string {
  const docs = getDocsMap();
  if (names.length === 0) {
    const all = [...docs.values()].filter((d) => d.name in helpers);
    return all;
  }
  if (names.length === 1) {
    const doc = docs.get(names[0]);
    if (!doc) return `Unknown helper: ${names[0]}`;
    return doc;
  }
  return names.map(
    (n) =>
      docs.get(n) || {
        name: n,
        signature: n,
        description: null,
        params: [],
        returns: null,
        async: false,
      },
  );
}

export function formatHelp(doc: HelperDoc): string {
  const lines: string[] = [];
  if (doc.description) {
    lines.push(doc.description);
  }
  for (const p of doc.params) {
    const opt = p.optional ? "?" : "";
    const type = p.type ? `: ${p.type}` : "";
    const desc = p.description ? ` — ${p.description}` : "";
    const def = p.default ? ` (default: ${p.default})` : "";
    lines.push(
      `@param ${p.rest ? "..." : ""}${p.name}${opt}${type}${desc}${def}`,
    );
  }
  if (doc.returns) {
    lines.push(`@returns ${doc.returns}`);
  }
  lines.push("");
  lines.push(doc.signature);
  return lines.join("\n");
}

function getDocsMap(): Map<string, HelperDoc> {
  if (cache) return cache;
  cache = new Map();
  for (const doc of parseEmbeddedDocs(EMBEDDED_DOCS_JSON)) {
    cache.set(doc.name, doc);
  }
  return cache;
}

function parseEmbeddedDocs(raw: string): HelperDoc[] {
  // If the build injection did not run (e.g. importing raw TypeScript), `raw`
  // is still the placeholder and JSON.parse throws; there are simply no docs.
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
