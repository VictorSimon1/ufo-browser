import { join } from "node:path";
import { ChromeLoginImportService } from "./chrome-import/service.js";
import { createChromeStableSourceAdapter } from "./chrome-import/discovery.js";
import { readChromeCookies } from "./chrome-import/cookies.js";
import { inspectChromeStorageSnapshot } from "./chrome-import/storage-preflight.js";
import { ProfileCloneService } from "./profile-clone/service.js";
import { ProfileAvatarStore } from "./profile-avatar-store.js";
import type { BrowserProfileRegistry } from "./profile-registry.js";
import type { NativeCefTaskSpaceManager } from "./native-cef-task-space-manager.js";
import { createNativeKeychain } from "./native-cef-keychain.js";

/** Profile operations shared by the Native CEF Overview and Agent service. */
export class NativeCefProfileService {
  private readonly chromeImport: ChromeLoginImportService;
  private readonly clone: ProfileCloneService;

  constructor(private readonly options: {
    userDataPath: string;
    partitionsRoot: string;
    sourcePartitionsRoot: string;
    profiles: BrowserProfileRegistry;
    manager: NativeCefTaskSpaceManager;
    keychainHelper: string;
    storageWorker?: string;
    chromeUserDataPath?: string;
    useMockKeychain?: boolean;
  }) {
    const keychain = createNativeKeychain(options.keychainHelper, options.useMockKeychain);
    const sourceAdapter = createChromeStableSourceAdapter(options.chromeUserDataPath);
    this.chromeImport = new ChromeLoginImportService({
      userDataPath: options.userDataPath,
      partitionsRoot: options.partitionsRoot,
      profiles: options.profiles,
      keychain,
      targetChromiumVersion: process.env.UFO_CEF_CHROMIUM_VERSION || "151.0.7922.138",
      chromeUserDataPath: options.chromeUserDataPath,
      sourceAdapter,
      readCookies: (path) => readChromeCookies(path, keychain),
      preflightStorage: async (_profileId, partitionId, copiedStorage) =>
        inspectChromeStorageSnapshot(
          join(options.partitionsRoot, partitionId),
          copiedStorage,
        ),
      createTarget: (profileId, partitionId) =>
        options.manager.createProfileCookieWriteTarget(profileId, partitionId),
    });
    const avatars = new ProfileAvatarStore(join(options.userDataPath, "Profile Avatars"));
    this.clone = new ProfileCloneService({
      profiles: options.profiles,
      partitionsRoot: options.partitionsRoot,
      avatars,
      // Native storage sync is owned by NativeCefProfileSync. The clone
      // transaction still needs this hook to preserve the shared service API.
      sync: { seedProfile: async () => undefined } as any,
      createTarget: (profile) =>
        options.manager.createProfileCookieWriteTarget(profile.id, profile.partitionId),
    });
  }

  discoverChrome() {
    return this.chromeImport.discover();
  }

  quitChrome() {
    return this.chromeImport.quitChrome();
  }

  importChrome(
    profileDirName: string,
    makeDefault: boolean,
    allowPartial: boolean,
  ) {
    return this.chromeImport.importProfile(profileDirName, makeDefault, allowPartial);
  }

  cloneUfo(
    sourceProfileId: string,
    name: string,
    makeDefault: boolean,
    loginSyncEnabled: boolean,
  ) {
    return this.clone.cloneUfoProfile({
      sourceProfileId,
      name,
      makeDefault,
      loginSyncEnabled,
    });
  }

  setDefault(profileId: string) {
    return this.options.profiles.setDefault(profileId);
  }

  remove(profileId: string) {
    if (this.options.manager.isProfileInUse(profileId)) {
      throw new Error("profile-in-use");
    }
    return this.options.profiles.remove(profileId);
  }

  setSync(profileId: string, enabled: boolean) {
    return this.options.profiles.setLoginSyncEnabled(profileId, enabled);
  }
}
