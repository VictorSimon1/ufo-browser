export type SpaceLease = {
  connectionId: string;
  generation: number;
};

export class SpaceLeaseRegistry {
  private readonly leases = new Map<number, SpaceLease>();
  private nextGeneration = 1;

  acquire(spaceId: number, connectionId: string): SpaceLease {
    const current = this.leases.get(spaceId);
    if (current && current.connectionId !== connectionId) {
      throw new Error("EGO_TASK_SPACE_UNAVAILABLE");
    }
    if (current) return current;
    const lease = { connectionId, generation: this.nextGeneration++ };
    this.leases.set(spaceId, lease);
    return lease;
  }

  assert(spaceId: number, connectionId: string, generation: number) {
    const current = this.leases.get(spaceId);
    if (
      !current ||
      current.connectionId !== connectionId ||
      current.generation !== generation
    ) {
      throw new Error("EGO_TASK_SPACE_UNAVAILABLE");
    }
  }

  release(spaceId: number, connectionId?: string) {
    const current = this.leases.get(spaceId);
    if (!current) return;
    if (connectionId && current.connectionId !== connectionId) return;
    this.leases.delete(spaceId);
  }

  releaseConnection(connectionId: string) {
    for (const [spaceId, lease] of this.leases) {
      if (lease.connectionId === connectionId) this.leases.delete(spaceId);
    }
  }

  current(spaceId: number) {
    return this.leases.get(spaceId);
  }
}
