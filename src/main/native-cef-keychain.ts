import {
  MacKeychainProvider,
  MockKeychainProvider,
  type KeychainProvider,
} from "./chrome-import/keychain.js";

const DEFAULT_MOCK_SECRET = "ufo-native-mock-safe-storage";

/**
 * Keep Native CEF's import and sync paths on the same Keychain contract.
 * Production always uses the signed macOS helper; the mock is opt-in and is
 * only intended for isolated smoke/E2E fixtures.
 */
export function createNativeKeychain(
  helperPath: string,
  useMock = process.env.UFO_CEF_USE_MOCK_KEYCHAIN === "1",
  mockSecret = process.env.UFO_CEF_MOCK_KEYCHAIN_SECRET || DEFAULT_MOCK_SECRET,
): KeychainProvider {
  return useMock
    ? new MockKeychainProvider(mockSecret)
    : new MacKeychainProvider(helperPath);
}

export { DEFAULT_MOCK_SECRET };
