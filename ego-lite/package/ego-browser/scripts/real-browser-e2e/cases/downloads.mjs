import { homeCase } from "./shared.mjs";

export const downloadCases = [
  {
    name: "download helpers",
    body: homeCase(`
      const downloadPromise = page.waitForEvent("download", { timeout: 5000 });
      await page.locator("#download-link").click();
      const download = await downloadPromise;
      assertEqual(download.suggestedFilename(), "sample-download.txt", "download exposes suggested filename");
      assertIncludes(download.url(), "/download/sample.txt", "download exposes source URL");
      const downloadedPath = await download.path();
      const downloadedText = await readFile(downloadedPath, "utf8");
      assertEqual(downloadedText, "download fixture", "download.path points at downloaded content");
      const savedPath = join(artifactDir, "saved-download.txt");
      await download.saveAs(savedPath);
      assertEqual(await readFile(savedPath, "utf8"), "download fixture", "download.saveAs copies content");
    `),
  },
];
