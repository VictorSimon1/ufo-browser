import assert from "node:assert/strict";
import test from "node:test";
import { CHROME_SAFE_STORAGE_SERVICE } from "../main/chrome-import/keychain.js";
import { createNativeKeychain } from "../main/native-cef-keychain.js";

test("Native CEF mock Keychain is explicit and shared by import/sync paths", async () => {
  const provider = createNativeKeychain(
    "/does/not/exist-in-an-isolated-test",
    true,
    "native-fixture-secret",
  );
  assert.deepEqual(
    await provider.readSecret(CHROME_SAFE_STORAGE_SERVICE),
    Buffer.from("native-fixture-secret"),
  );
});
