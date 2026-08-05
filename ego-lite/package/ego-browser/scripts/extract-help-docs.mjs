import { parse } from "acorn";

// Build-time helper-doc extraction.
//
// Historically this ran at runtime inside help-runtime.ts by reading the
// module's own source (fileURLToPath(import.meta.url) + readFileSync). That
// only works when the SDK is loaded from a real file. In the shipped browser
// the SDK is loaded from a compiled .pak resource whose import.meta.url is
// "ego://services/node/resources/index.js", so fileURLToPath throws and the
// docs map was permanently empty. The extraction now happens at build time
// against the emitted bundle and the result is embedded as data, so the
// runtime never touches its own source. See GitHub issue #84.

/**
 * Parse bundled JS source and return the helper docs used by help()/formatHelp().
 * @param {string} source Bundled JavaScript with comments preserved.
 * @returns {Array<{name: string, signature: string, description: string | null, params: Array<object>, returns: string | null, async: boolean}>}
 */
export function extractHelpDocs(source) {
  const docs = new Map();

  const comments = [];
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    onComment: comments,
    locations: true,
  });

  const commentsByEndLine = new Map();
  for (const c of comments) {
    if (c.type === "Block") {
      commentsByEndLine.set(c.loc.end.line, c);
    }
  }

  walkFunctions(ast, (node) => {
    const name = extractFunctionName(node);
    if (!name) return;

    const startLine = node.loc.start.line;
    const jsDoc = commentsByEndLine.get(startLine - 1);
    const parsed = jsDoc ? parseJSDoc(jsDoc.value) : null;

    const params = extractParams(node, parsed);
    const isAsync = node.async === true;
    const paramSig = params
      .map((p) => {
        const rest = p.rest ? "..." : "";
        const opt = p.optional ? "?" : "";
        return `${rest}${p.name}${opt}`;
      })
      .join(", ");
    const retStr = parsed?.returns || (isAsync ? "Promise<...>" : null);
    const signature = `${name}(${paramSig})${retStr ? ` → ${retStr}` : ""}`;

    docs.set(name, {
      name,
      signature,
      description: parsed?.description || null,
      params,
      returns: retStr,
      async: isAsync,
    });
  });

  walkAliases(ast, (name, target) => {
    const existing = docs.get(target);
    if (existing && !docs.has(name)) {
      docs.set(name, { ...existing, name });
    }
  });

  return [...docs.values()];
}

function walkFunctions(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression"
  ) {
    visitor(node);
  }
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "loc" || key === "start" || key === "end")
      continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") walkFunctions(item, visitor);
      }
    } else if (child && typeof child.type === "string") {
      walkFunctions(child, visitor);
    }
  }
}

function walkAliases(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type === "VariableDeclaration") {
    for (const decl of node.declarations || []) {
      if (decl.id?.type === "Identifier" && decl.init?.type === "Identifier") {
        visitor(decl.id.name, decl.init.name);
      }
    }
  }
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "loc" || key === "start" || key === "end")
      continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") walkAliases(item, visitor);
      }
    } else if (child && typeof child.type === "string") {
      walkAliases(child, visitor);
    }
  }
}

function extractFunctionName(node) {
  if (node.id?.name) return node.id.name;
  return null;
}

function extractParams(node, jsdoc) {
  return (node.params || []).map((p) => {
    const info = resolveParam(p);
    const jsdocParam = jsdoc?.params.find((jp) => jp.name === info.name);
    return {
      ...info,
      type: jsdocParam?.type || null,
      description: jsdocParam?.description || null,
    };
  });
}

function parseJSDoc(raw) {
  const lines = raw.split("\n").map((l) => l.replace(/^\s*\*\s?/, "").trim());
  const descLines = [];
  const params = [];
  let returns = null;

  for (const line of lines) {
    const paramMatch = line.match(
      /^@param\s+(?:\{([^}]*)\}\s+)?(\[?\w+\]?)(?:(?:\s+[-–—]\s*|\s+)(.+))?\s*$/,
    );
    if (paramMatch) {
      const name = paramMatch[2].replace(/^\[|\]$/g, "");
      params.push({
        name,
        type: paramMatch[1] || null,
        description: paramMatch[3] || null,
      });
      continue;
    }
    const returnsMatch = line.match(/^@returns?\s+(?:\{([^}]*)\}\s*)?(.*)/);
    if (returnsMatch) {
      returns = returnsMatch[1] || returnsMatch[2] || null;
      continue;
    }
    if (line.startsWith("@")) continue;
    if (line) descLines.push(line);
  }

  return {
    description: descLines.join(" ").trim() || null,
    params,
    returns,
  };
}

function resolveParam(node) {
  if (node.type === "RestElement") {
    const inner = resolveParam(node.argument);
    return { ...inner, rest: true, optional: true };
  }
  if (node.type === "AssignmentPattern") {
    const inner = resolveParam(node.left);
    const defStr = nodeToString(node.right);
    return { ...inner, optional: true, default: defStr };
  }
  if (node.type === "Identifier") {
    return { name: node.name, optional: false, rest: false, default: null };
  }
  if (node.type === "ObjectPattern") {
    const props = (node.properties || [])
      .map((p) => p.key?.name || "?")
      .join(", ");
    return { name: `{${props}}`, optional: false, rest: false, default: null };
  }
  if (node.type === "ArrayPattern") {
    return { name: "[...]", optional: false, rest: false, default: null };
  }
  return { name: "?", optional: false, rest: false, default: null };
}

function nodeToString(node) {
  if (!node) return "?";
  if (node.type === "Literal") return JSON.stringify(node.value);
  if (node.type === "ObjectExpression") return "{}";
  if (node.type === "ArrayExpression") return "[]";
  if (node.type === "Identifier") return node.name;
  return "...";
}
