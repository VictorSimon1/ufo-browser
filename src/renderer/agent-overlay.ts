const api = (window as any).xBrowser;
const name = document.querySelector<HTMLElement>("#space-name")!;
const detail = document.querySelector<HTMLElement>("#task-detail")!;
const pointer = document.querySelector<HTMLElement>("#agent-pointer")!;
const pointerLabel = document.querySelector<HTMLElement>("#pointer-label")!;
const takeOver = document.querySelector<HTMLButtonElement>("#take-over")!;
const stopTask = document.querySelector<HTMLButtonElement>("#stop-task")!;
const transitionStage = document.querySelector<HTMLElement>("#space-transition")!;
const transitionOverview = document.querySelector<HTMLImageElement>(
  "#transition-overview",
)!;
const transitionShade = document.querySelector<HTMLElement>("#transition-shade")!;
const transitionSurface = document.querySelector<HTMLElement>(
  "#transition-surface",
)!;
const transitionChrome = document.querySelector<HTMLImageElement>(
  "#transition-chrome",
)!;
const transitionPage = document.querySelector<HTMLImageElement>(
  "#transition-page",
)!;

let state: any;
let pointerTimer: ReturnType<typeof setTimeout> | undefined;
let transitionToken = "";
let transitionFrom = "none";
let transitionDuration = 1;

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

api.overlay.onSpaceTransition((next: any) => {
  const phase = String(next?.phase || "");
  if (phase === "prepare") void prepareSpaceTransition(next);
  if (phase === "go") void runSpaceTransition(next);
  if (phase === "cancel") cancelSpaceTransition(String(next?.token || ""));
});

async function prepareSpaceTransition(next: any) {
  const token = String(next?.token || "");
  if (!token) return;
  transitionToken = token;
  transitionStage.getAnimations({ subtree: true }).forEach((animation) =>
    animation.cancel(),
  );
  transitionStage.hidden = false;
  transitionStage.classList.remove("ready");
  document.body.classList.add("space-transitioning");

  const source = next?.source || {};
  const viewport = next?.viewport || {};
  const width = Math.max(1, Number(viewport.width) || innerWidth || 1);
  const height = Math.max(1, Number(viewport.height) || innerHeight || 1);
  const sourceX = Math.max(0, Number(source.x) || 0);
  const sourceY = Math.max(0, Number(source.y) || 0);
  const sourceWidth = Math.max(1, Number(source.width) || 1);
  const sourceHeight = Math.max(1, Number(source.height) || 1);
  transitionFrom = `translate3d(${sourceX}px, ${sourceY}px, 0) scale(${sourceWidth / width}, ${sourceHeight / height})`;
  transitionDuration = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 1
    : Math.max(1, Number(next?.durationMs) || 180);

  transitionStage.dataset.token = token;
  transitionStage.dataset.motion = "space-live-handoff-v2";
  transitionStage.dataset.durationMs = String(transitionDuration);
  transitionStage.dataset.sourceWidth = String(sourceWidth);
  transitionStage.dataset.sourceHeight = String(sourceHeight);
  transitionStage.style.setProperty(
    "--transition-chrome-height",
    `${Math.max(1, Number(next?.chromeHeight) || 82)}px`,
  );
  transitionStage.style.setProperty(
    "--transition-page-height",
    `${Math.max(1, Number(next?.pageHeight) || height)}px`,
  );
  transitionSurface.style.transform = transitionFrom;
  transitionSurface.style.borderRadius = "18px";
  transitionSurface.style.boxShadow = "0 18px 44px rgba(25, 46, 39, 0.15)";
  transitionShade.style.opacity = "0";
  transitionOverview.src = String(next?.overview || "");
  transitionChrome.src = String(next?.chrome || "");
  transitionPage.src = String(next?.page || "");

  await Promise.all([
    decodeImage(transitionOverview),
    decodeImage(transitionChrome),
    decodeImage(transitionPage),
  ]);
  if (transitionToken !== token) return;
  transitionStage.classList.add("ready");
  await nextPaint();
  if (transitionToken !== token) return;
  await api.overlay.transitionReady(token).catch(() => undefined);
}

async function runSpaceTransition(next: any) {
  const token = String(next?.token || "");
  if (!token || token !== transitionToken || transitionStage.hidden) return;
  const surfaceAnimation = transitionSurface.animate(
    [
      {
        transform: transitionFrom,
        borderRadius: "18px",
        boxShadow: "0 18px 44px rgba(25, 46, 39, 0.15)",
      },
      {
        transform: "translate3d(0, 0, 0) scale(1, 1)",
        borderRadius: "0px",
        boxShadow: "0 0 0 rgba(25, 46, 39, 0)",
      },
    ],
    {
      duration: transitionDuration,
      easing: "cubic-bezier(.2, .78, .22, 1)",
      fill: "forwards",
    },
  );
  const shadeAnimation = transitionShade.animate(
    [{ opacity: 0 }, { opacity: 1 }],
    {
      duration: transitionDuration,
      easing: "cubic-bezier(.24, .68, .24, 1)",
      fill: "forwards",
    },
  );
  await Promise.all([
    surfaceAnimation.finished.catch(() => undefined),
    shadeAnimation.finished.catch(() => undefined),
  ]);
  if (transitionToken !== token) return;
  transitionStage.hidden = true;
  transitionStage.classList.remove("ready");
  await api.overlay.transitionFinished(token).catch(() => undefined);
  if (transitionToken !== token) return;
  document.body.classList.remove("space-transitioning");
  clearTransitionImages();
  transitionToken = "";
}

function cancelSpaceTransition(token: string) {
  if (token && token !== transitionToken) return;
  transitionToken = "";
  transitionStage.getAnimations({ subtree: true }).forEach((animation) =>
    animation.cancel(),
  );
  transitionStage.hidden = true;
  transitionStage.classList.remove("ready");
  document.body.classList.remove("space-transitioning");
  clearTransitionImages();
}

function decodeImage(image: HTMLImageElement) {
  if (image.complete && image.naturalWidth > 0) return Promise.resolve();
  return image.decode().catch(() => undefined);
}

function nextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function clearTransitionImages() {
  transitionOverview.removeAttribute("src");
  transitionChrome.removeAttribute("src");
  transitionPage.removeAttribute("src");
}

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
