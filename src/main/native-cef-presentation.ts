import type { NativeCefOverview, NativeCefOverviewPresentation } from "./native-cef-overview.js";
import type { NativeCefTaskSpaceManager } from "./native-cef-task-space-manager.js";

export type NativeCefPresentationState =
  | { kind: "overview" }
  | { kind: "space"; spaceId: number };

/** Single owner for the visible native CEF surface. */
export class NativeCefPresentationCoordinator implements NativeCefOverviewPresentation {
  private state: NativeCefPresentationState = { kind: "overview" };

  constructor(
    private readonly manager: NativeCefTaskSpaceManager,
    private readonly overview: NativeCefOverview,
  ) {}

  async openSpace(spaceId: number) {
    await this.manager.presentSpace(spaceId);
    await this.overview.hideWindow();
    this.state = { kind: "space", spaceId };
  }

  async showOverview() {
    await this.manager.hideRunningSpaces();
    await this.overview.showWindow();
    await this.overview.focusWindow();
    this.state = { kind: "overview" };
  }

  async closeSpace(spaceId: number) {
    const closed = await this.manager.closeSpace(spaceId);
    if (closed && this.state.kind === "space" && this.state.spaceId === spaceId) {
      await this.showOverview();
    }
    return closed;
  }

  async onSpaceClosed(spaceId: number) {
    if (this.state.kind === "space" && this.state.spaceId === spaceId) {
      await this.showOverview();
    }
  }

  async onSpaceStateChanged(spaceId: number) {
    // Handoff/completion should return an already-running Space to the human;
    // if Overview is currently visible, do not unexpectedly steal focus.
    if (this.state.kind === "space" && this.state.spaceId === spaceId) {
      await this.manager.showSpace(spaceId).catch(() => undefined);
    }
  }

  getState() {
    return this.state;
  }
}
