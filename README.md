# X-Browser

X-Browser is a local-first Electron browser where people and AI agents work in isolated Task Spaces. It provides an Ego-compatible JavaScript Skill/CLI surface, preserves normal browser interaction for the user, and keeps Agent-controlled pages in background browser contexts without moving the system pointer or opening remote-debugging ports.

Current development priorities:

- Ego-compatible `x-browser nodejs` helpers and Task Space ownership semantics.
- Chromium/OOPIF behavior capable of completing JanitorAI's Turnstile flow.
- Live, bounded 3:2 Space previews that continue rendering internal page changes.
- macOS-style browser interaction, window lifecycle, overlays, tab handling, and restart recovery.
- Strict real-Ego fingerprint and helper-parity regression gates.

Chrome Profile/Cookie import and final packaged installation remain intentionally deferred while the temporary development App is being refined.

## Development

```bash
npm install
npm test
npm run verify:helper-parity
npm run verify:fingerprint
npm run verify:janitor
npm run verify:live-preview
npm run verify:restart-scale
```

Run the temporary App:

```bash
X_BROWSER_TEST_APP=1 npm run test:app:reuse
```

The authoritative architecture, protected contracts, milestones, and verification notes are maintained in [goal.md](goal.md).

## Ego compatibility source

The `ego-lite/` directory contains the open-source Ego browser Skill/runtime source used as the compatibility reference and build input. Its original license is preserved in [ego-lite/LICENSE](ego-lite/LICENSE).
