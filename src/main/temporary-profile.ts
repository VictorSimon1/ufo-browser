import { randomUUID } from "node:crypto";
import type { SpaceRecord } from "./types.js";

export const TEMPORARY_PROFILE_ID = "temporary";
export const TEMPORARY_AGENT_PROFILE_ID = "Temporary";
export const TEMPORARY_PROFILE_NAME = "临时 Profile";
const TEMPORARY_PARTITION_PREFIX = "ufo-temporary-space-";

export type PublicTemporaryProfile = {
  id: typeof TEMPORARY_PROFILE_ID;
  isDefault: false;
  name: typeof TEMPORARY_PROFILE_NAME;
  kind: "temporary";
  ephemeral: true;
};

export function temporaryPublicProfile(): PublicTemporaryProfile {
  return {
    id: TEMPORARY_PROFILE_ID,
    isDefault: false,
    name: TEMPORARY_PROFILE_NAME,
    kind: "temporary",
    ephemeral: true,
  };
}

export function isTemporaryProfileId(value: unknown) {
  return (
    typeof value === "string" &&
    value.trim().toLowerCase() === TEMPORARY_PROFILE_ID
  );
}

export function createTemporarySessionScope() {
  return randomUUID();
}

export function temporarySessionPartition(sessionScopeId: string) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      sessionScopeId,
    )
  ) {
    throw new Error("invalid temporary Space session scope");
  }
  return `${TEMPORARY_PARTITION_PREFIX}${sessionScopeId}`;
}

export function isTemporarySpace(
  space: Pick<SpaceRecord, "profileId" | "profileMode"> | Record<string, unknown>,
) {
  return space.profileMode === "temporary" || isTemporaryProfileId(space.profileId);
}
