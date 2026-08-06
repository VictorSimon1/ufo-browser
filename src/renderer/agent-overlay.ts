const api = (window as any).xBrowser;
const name = document.querySelector<HTMLElement>("#space-name")!;
const detail = document.querySelector<HTMLElement>("#task-detail")!;
const pointer = document.querySelector<HTMLElement>("#agent-pointer")!;
const pointerLabel = document.querySelector<HTMLElement>("#pointer-label")!;
const takeOver = document.querySelector<HTMLButtonElement>("#take-over")!;
const stopTask = document.querySelector<HTMLButtonElement>("#stop-task")!;

let state: any;
let pointerTimer: ReturnType<typeof setTimeout> | undefined;

api.overlay.onState((next: any) => {
  state = next;
  name.textContent = next?.name || "Browser Agent";
  detail.textContent = next?.task?.detail || "Agent 正在控制";
  document.body.dataset.spaceId = String(next?.spaceId || "");
  document.body.dataset.overlayDesign = "agent-dot-matrix-v3";
  document.body.dataset.overlayMotion = "ambient-sweep-v2";
});

api.overlay.onPointer((next: any) => {
  const x = Math.max(8, Math.min(innerWidth - 30, Number(next?.x) || 0));
  const y = Math.max(8, Math.min(innerHeight - 34, Number(next?.y) || 0));
  pointer.style.setProperty("--x", `${x}px`);
  pointer.style.setProperty("--y", `${y}px`);
  pointerLabel.textContent = String(next?.label || "正在浏览网页").slice(0, 80);
  pointer.classList.add("visible");
  if (pointerTimer) clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => {
    pointer.classList.remove("visible");
    pointerTimer = undefined;
  }, 1400);
});

takeOver.addEventListener("click", () => {
  if (state?.spaceId) void api.control.takeOver(Number(state.spaceId));
});

stopTask.addEventListener("click", () => {
  if (state?.spaceId) void api.control.complete(Number(state.spaceId));
});

document.addEventListener("contextmenu", (event) => event.preventDefault());
window.addEventListener("keydown", (event) => {
  event.preventDefault();
  event.stopPropagation();
});
