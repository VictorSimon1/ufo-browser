import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHROME_SAFE_STORAGE_SERVICE,
  MacKeychainProvider,
} from "../main/chrome-import/keychain.js";

test(
  "macOS Keychain provider invokes a Chrome-only helper without arguments",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ufo-keychain-provider-"));
    const helperPath = join(root, "fixture-helper");
    try {
      await writeFile(
        helperPath,
        '#!/bin/sh\n[ "$#" -eq 0 ] || exit 9\nprintf fixture-secret\n',
      );
      await chmod(helperPath, 0o700);
      const provider = new MacKeychainProvider(helperPath);
      const secret = await provider.readSecret(CHROME_SAFE_STORAGE_SERVICE);
      try {
        assert.equal(secret.toString("utf8"), "fixture-secret");
      } finally {
        secret.fill(0);
      }
      await assert.rejects(
        provider.readSecret("Unrelated Safe Storage"),
        /invalid Keychain service/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
