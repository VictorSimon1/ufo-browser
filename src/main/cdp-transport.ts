/**
 * Browser-protocol transport used by UFO's agent-facing services.
 *
 * The product must not depend on Electron's WebContents debugger API.  Both
 * the legacy Electron host and the native CEF host implement this small
 * contract, so SnapshotService/CdpBroker can be moved to the standalone
 * Agent Service without changing the Skill or CLI protocol.
 */
export type CdpEvent = {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

export interface CdpTransport {
  sendCommand(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<any>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  close(): Promise<void>;
}

export type ElectronDebugger = {
  isAttached(): boolean;
  attach(version: string): void;
  sendCommand(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<any>;
  on(
    event: "message",
    listener: (
      event: unknown,
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => void,
  ): void;
  off(
    event: "message",
    listener: (
      event: unknown,
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => void,
  ): void;
  detach?(): void;
};

/** Adapter retained only for the Electron migration fallback. */
export class ElectronCdpTransport implements CdpTransport {
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly messageListener = (
    _event: unknown,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) => {
    const event = { method, params, sessionId } satisfies CdpEvent;
    for (const listener of this.listeners) listener(event);
  };

  constructor(private readonly debuggerApi: ElectronDebugger) {
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
    debuggerApi.on("message", this.messageListener);
  }

  sendCommand(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    return this.debuggerApi.sendCommand(method, params, sessionId);
  }

  onEvent(listener: (event: CdpEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close() {
    this.debuggerApi.off("message", this.messageListener);
    this.listeners.clear();
    this.debuggerApi.detach?.();
  }
}

