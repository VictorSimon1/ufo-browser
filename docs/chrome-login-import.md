# Chrome login-state import

UFO-Browser can copy a selected Google Chrome Stable Profile's website login state into a new, isolated UFO Profile on macOS. The source Chrome Profile remains unchanged, and no imported Profile becomes visible until the transaction has passed Cookie verification and is committed to the Profile Registry.

## Product boundary

Imported data:

- regular, HttpOnly, Secure, SameSite, persistent, and session Cookies;
- CHIPS / partitioned Cookies, including the top-level site and cross-site ancestor bit;
- Local Storage;
- IndexedDB;
- WebStorage;
- File System / OPFS;
- Storage, QuotaManager, and QuotaManager journal metadata;
- Service Worker data only when the source and target Chromium major versions pass the compatibility preflight.

Not imported:

- saved passwords, payment data, Autofill, Passkeys, or WebAuthn private keys;
- Chrome Sync tokens, Google browser-account state, or device-bound credentials;
- history, downloads, bookmarks, Favicons, extensions, tabs, windows, or tab groups;
- Session Storage, push tokens, policies, Secure Preferences, or browser caches.

Session Cookies receive an expiry 30 days from import so they can survive a UFO-Browser restart. This is shown in the product copy. The import is a one-time snapshot; `loginSyncEnabled` remains `false`, and there is no timer that can restore a Cookie after the user signs out in UFO-Browser.

## Runtime flow

```text
discover
  → wait for a confirmed normal Chrome exit
  → create a protected snapshot job
  → activate storage into a new partition
  → parse/decrypt Cookies in a Worker
  → write regular Cookies with Electron
  → write CHIPS with same-partition CDP
  → flush and verify Cookies
  → atomically publish the Profile
```

The implementation lives under `src/main/chrome-import/`:

- `discovery.ts` discovers `Default` and `Profile N` from Chrome `Local State`, validates direct-child paths, estimates import size, detects `SingletonLock`, and exposes the Chrome Stable source adapter.
- `transaction.ts` owns the job manifest, safe allowlisted copy, partition activation, publication, failure journal, and cold-start recovery.
- `keychain.ts` calls the restricted macOS helper for `Chrome Safe Storage`. Tests use `MockKeychainProvider`.
- `worker-reader.ts` transfers the Keychain result in memory to `chrome-cookie-worker.js`; the source secret Buffer is cleared after transfer.
- `cookies.ts` reads Chrome SQLite through `node:sqlite`, supports `v10`/`v11`, PBKDF2-HMAC-SHA1, AES-128-CBC, Cookie DB v24 host digests, timestamp conversion, and sanitized warning counts.
- `cookie-writer.ts` and `electron-target.ts` write and verify regular and partitioned Cookies in the same target partition.
- `service.ts` coordinates progress, failure mapping, transaction commit, and sanitized results.

The Profile Registry is `profiles.json`. Each imported Profile owns a generated partition such as `x-browser-profile-chrome-<id>`. New Spaces use the current default Profile unless the user explicitly selects another one; existing Spaces retain their original `profileId`.

The selection screen shows the Chrome directory, last-used date, and estimated import size. It also requires an explicit checkbox decision about whether UFO-Browser may publish a partial Profile when a small subset cannot be migrated safely. This consent is off by default, so a partial Profile is never published unless the user actively opts in.

Profile discovery gives all listed Profiles one shared 350 ms size-estimation budget and a bounded filesystem-entry budget. It prefers `Network/Cookies` over the legacy root database, includes quota metadata, skips symlinks and inaccessible estimate-only entries, and may conservatively undercount very large Profiles rather than blocking the selection UI.

Before import, the UI states that processing stays on the current Mac, that passwords, credit cards, history, and Google Sync state are excluded, and that Passkey-, device-bound-, or client-certificate-based sites may require a fresh login. A successful result therefore describes most sites as reusable instead of promising universal login continuity.

During snapshotting, the UI advances across the fixed allowlisted datasets (Cookies, Local Storage, IndexedDB, WebStorage, File System/OPFS, storage/quota metadata, and compatible Service Worker data). Progress events contain only these stable dataset labels and numeric counters; they never expose source paths, origins, domains, or stored values, and a failed progress observer cannot abort the transaction.

Cookie rows are streamed from SQLite inside the Worker instead of materializing the full query result before conversion. The 10,000-Cookie gate therefore keeps parsing off the main event loop and avoids holding both a complete raw-row array and the converted import array at once.

## Source consistency and file safety

Chrome must be normally closed before the snapshot. If `SingletonLock` points to a live process, the UI offers **退出 Chrome 并继续** or cancel. The quit action uses a normal macOS application quit request and waits for the lock to clear; it never uses `killall` or `SIGKILL`.

The source lock is checked before discovery, immediately before snapshotting, and again after the snapshot completes. If Chrome starts while LevelDB, IndexedDB, or Service Worker data is being copied, the snapshot is discarded before the target partition is activated.

Import jobs are stored below the UFO-Browser user-data directory with directory mode `0700` and file mode `0600`. Source Profiles must be direct, non-symlink children of Chrome User Data. The copy skips symlinks, copies only an allowlist, and uses `COPYFILE_FICLONE` so APFS can clone-on-write with a normal-copy fallback.

The Chrome Cookies database itself is never installed into the destination partition. The snapshot prefers the modern `Network/Cookies` location and falls back to the legacy root `Cookies` database only when needed. It is read from staging, decrypted, converted, and written through the target Chromium session so UFO-Browser owns the resulting Cookie store.

## Keychain and sensitive data

Production reads the macOS generic-password item whose service is `Chrome Safe Storage` through `dist/bin/ufo-keychain-helper`, implemented with Security.framework. The helper is hardcoded to that one service and accepts no command-line arguments, so it cannot act as a general Keychain lookup surface. macOS may show its native password or Touch ID authorization UI. UFO-Browser never asks for or stores the macOS password itself.

The import requests the Safe Storage secret lazily and at most once. Canceling or denying the native authorization aborts the transaction immediately; it is never downgraded to a per-Cookie warning or a publishable partial Profile.

The Safe Storage secret and Cookie values must not appear in logs, command-line parameters, environment variables, error text, screenshots, audit JSON, or persisted job manifests. The helper writes only the secret bytes to its restricted stdout; the main process transfers them to the Worker in memory and clears the assembled secret plus every stdout chunk. Derived keys and decrypted temporary Buffers are cleared after use.

Failures are exposed as stable codes and counts such as `keychain-canceled`, `cookie-decryption-failed`, or `host-digest-mismatch`, without domain names or values.

Persisted job manifests accept only an explicit allowlist of stable failure codes. Any unknown or dynamically generated error text is reduced to `chrome-import-failed` before `job.json` is written, so exception messages cannot persist Cookie, token, domain, or authorization fragments.

The same rule applies before a transaction exists: discovery, normal-quit, import preflight, and best-effort rollback errors cross the renderer boundary only as stable codes. Raw filesystem, SQLite, AppleScript, or helper diagnostics never become UI error payloads.

## Transaction and deletion behavior

The job progresses through:

```text
discovered → snapshotting → preparing-profile → importing-storage
→ importing-cookies → verifying → publishing → committed
```

Failure states are `failed`, `partial`, or `cleanup-pending`.

- The old default Profile and all existing Spaces are never overwritten.
- A Profile is added to `profiles.json` only after verification. A partial result is published only when the user explicitly allowed partial import on the confirmation screen.
- If the generated target partition path already exists, the transaction aborts and removes only its own staging job; the pre-existing partition is never treated as rollback-owned data.
- Registry mutations are serialized as next-state writes: the in-memory Profile list changes only after the atomic file replacement succeeds, and a failed write does not poison later retries.
- The atomic Profile Registry write is the durable commit point. Failure to write the final job marker or remove its temporary directory after that point does not report a false import failure; cold-start recovery preserves the published partition and removes any leftover journal.
- The job manifest records both source and target Chromium versions. An incompatible Service Worker dataset is skipped with the sanitized `service-worker-version-mismatch` warning and makes the result partial. A safe-copy failure isolated to the optional Service Worker dataset is cleaned up and reported as `service-worker-copy-failed`; required storage copy failures still abort and roll back the import.
- If a target Session was created before failure, the partition is left journaled and removed on the next cold start before reuse.
- Published partitions are preserved during job recovery.
- Removing an imported Profile immediately removes it from the registry and queues its partition for cold-start deletion.
- A Profile that is still referenced by a Space cannot be removed.
- The built-in local Profile cannot be removed.

## Automated verification

Automated tests must never discover or copy the user's real Chrome Profile and must never invoke the real Keychain helper. They use `.x-browser-test/runs/chrome-import-*`, an isolated Chrome fixture, and `MockKeychainProvider`.

```bash
npm run typecheck
npm test
npm run verify:chrome-import
npm run verify:chrome-import-restart
npm run verify:chrome-import-rollback
```

The fixture creates encrypted v24 Cookies, one CHIPS Cookie, and real origin storage through Chromium. The success and restart audits load the same fixture origin from the imported partition and semantically read Local Storage, IndexedDB, and OPFS. WebStorage and File System allowlist copying also has file markers. Rollback uses the wrong mock key and verifies that no Profile, partition, or job leaks.

Current isolated evidence proves:

- two Cookies are persisted, including one CHIPS Cookie;
- a 10,000-Cookie batch keeps writes at the configured concurrency limit and verifies through indexed identity lookups instead of quadratic scans;
- Local Storage, IndexedDB, and OPFS are readable from the imported partition;
- WebStorage and File System markers survive restart;
- the imported Profile can become default and be selected by a new Space;
- the UI displays last-used metadata and records explicit partial-import consent;
- an unapproved partial result publishes no Profile;
- an incorrect key publishes nothing and is cleaned on restart.

`npm run package:mac:test` additionally starts the packaged `UFO-Browser.app` with the same isolated fixture and completes the success audit. This verifies that `chrome-cookie-worker.js` can run from `app.asar`, the unpacked Keychain helper path resolves, and the packaged Bundle can persist Cookie/CHIPS and origin storage without using the real Keychain.

## Remaining real-machine acceptance

The only intentionally deferred acceptance step is a user-initiated import from the formal UI against a real Chrome Stable Profile. The user must be present to approve the native Keychain password or Touch ID prompt. That check should confirm that the real `Chrome Safe Storage` item decrypts the installed Chrome Cookie database without printing sensitive material.
