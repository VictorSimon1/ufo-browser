/**
 * Shared case-construction helpers for E2E case files.
 *
 * caseBody / homeCase wrap a case body string with the common boilerplate
 * (taskSpaces.useOrCreate + resetHome) so each case file only expresses its
 * unique logic. buttonRefSetup returns a reusable snippet for snapshot-based
 * ref resolution.
 */

export function caseBody(body) {
  return () => `
    await taskSpaces.useOrCreate(taskName);
    ${body}
  `;
}

export function homeCase(body) {
  return caseBody(`
    await resetHome();
    ${body}
  `);
}

export function buttonRefSetup() {
  return `
    const snap = await page.snapshotRaw({
      scope: "full_page",
      includeActionMarks: true,
      includeStableLocator: true,
    });
    const buttonRef = (snap.refs || []).find(
      (ref) =>
        String(ref?.role || "") === "button" &&
        String(ref?.name || "").includes("Increment counter")
    )?.backendNodeId;
    assert(buttonRef, "snapshotRaw exposes increment button ref");
  `;
}
