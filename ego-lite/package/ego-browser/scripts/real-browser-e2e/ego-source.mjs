import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const preamble = readFileSync(join(__dirname, "preamble.mjs"), "utf-8");

export function egoSource(body, context) {
  const {
    taskName,
    baseUrl,
    artifactDir,
    tempDir,
    uploadPath,
    uploadPathTwo,
    explicitScreenshotPath,
    environmentScreenshotPath,
    metadataPath,
    keepTaskSpace,
  } = context;
  return `
    ${preamble}

    const verboseAssertions =
      process.env.EGO_BROWSER_REAL_E2E_VERBOSE_ASSERTIONS === "1" ||
      process.env.EGO_BROWSER_REAL_E2E_VERBOSE_ASSERTIONS === "true";

    const taskName = ${JSON.stringify(taskName)};
    const baseUrl = ${JSON.stringify(baseUrl)};
    const artifactDir = ${JSON.stringify(artifactDir)};
    const tempDir = ${JSON.stringify(tempDir)};
    const uploadPath = ${JSON.stringify(uploadPath)};
    const uploadPathTwo = ${JSON.stringify(uploadPathTwo)};
    const explicitScreenshotPath = ${JSON.stringify(explicitScreenshotPath)};
    const environmentScreenshotPath = ${JSON.stringify(environmentScreenshotPath)};
    const metadataPath = ${JSON.stringify(metadataPath)};
    const keepTaskSpace = ${JSON.stringify(keepTaskSpace)};

    try {
      ${body}
      console.log(JSON.stringify({ ok: true, assertions: __assertionCount }));
      await writeFile(join(tempDir, "case-result.json"), JSON.stringify({ ok: true, assertions: __assertionCount }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, assertions: __assertionCount, error: error.message }));
      await writeFile(join(tempDir, "case-result.json"), JSON.stringify({ ok: false, assertions: __assertionCount, error: error.message })).catch(() => {});
      error.message = ${JSON.stringify("real browser e2e")} + ": " + error.message;
      throw error;
    }
  `;
}
