import { displayNavigationAddress } from "./browser-address.js";

const api = (window as any).xBrowser;
const tabs = document.querySelector<HTMLElement>("#tabs")!;
const address = document.querySelector<HTMLInputElement>("#address")!;
const form = document.querySelector<HTMLFormElement>("#address-form")!;
const addressShell = document.querySelector<HTMLElement>(".address-shell")!;
const lock = document.querySelector<HTMLElement>("#chrome-lock")!;
const progress = document.querySelector<HTMLElement>("#page-progress")!;
const reload = document.querySelector<HTMLButtonElement>("#reload")!;
const newTab = document.querySelector<HTMLButtonElement>("#new-tab")!;
const back = document.querySelector<HTMLButtonElement>("#back")!;
const forward = document.querySelector<HTMLButtonElement>("#forward")!;
let state: any;
let addressEditing = false;
let activeTargetId = "";
let navigationToken = 0;
let pendingNavigation:
  | { token: number; targetId: string; display: string }
  | undefined;
const tabButtons = new Map<string, HTMLButtonElement>();
let tabCommandQueue = Promise.resolve();
let draggedTargetId = "";
let dropTarget: HTMLButtonElement | undefined;

document.querySelector("#spaces-button")!.addEventListener("click", async () => {
  await api.browser.showOverview();
});
newTab.addEventListener("click", () => void createNewTab());
tabs.addEventListener("dblclick", (event) => {
  if (event.target !== tabs || isControlled()) return;
  void createNewTab();
});
tabs.addEventListener("dragover", (event) => {
  if (!draggedTargetId || event.target !== tabs) return;
  event.preventDefault();
  clearDropIndicator();
  tabs.classList.add("drop-end");
});
tabs.addEventListener("drop", (event) => {
  if (!draggedTargetId || event.target !== tabs) return;
  event.preventDefault();
  const targetId = draggedTargetId;
  clearDragState();
  queueTabCommand(() => reorderTargetTab(targetId, null));
});
back.addEventListener("click", () => api.browser.back());
forward.addEventListener("click", () => api.browser.forward());
reload.addEventListener("click", () => api.browser.reload());
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (isControlled() || pendingNavigation) return;
  const input = address.value.trim();
  const token = ++navigationToken;
  pendingNavigation = {
    token,
    targetId: state?.space?.activeTabId || "",
    display: input,
  };
  addressEditing = false;
  address.blur();
  addressShell.classList.remove("navigation-error");
  addressShell.classList.add("navigating");
  form.setAttribute("aria-busy", "true");
  void submitNavigation(input, token);
});
address.addEventListener("focus", () => {
  addressEditing = true;
  addressShell.classList.remove("navigation-error");
  address.removeAttribute("title");
  address.select();
});
address.addEventListener("input", () => {
  addressEditing = true;
  addressShell.classList.remove("navigation-error");
  address.removeAttribute("title");
});
address.addEventListener("blur", () => {
  addressEditing = false;
});
address.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    address.value = currentDisplayAddress();
    addressEditing = false;
    address.blur();
  }
});
window.addEventListener("keydown", (event) => {
  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.key === "Tab"
  ) {
    event.preventDefault();
    if (isControlled()) return;
    queueTabCommand(() => activateRelativeTab(event.shiftKey ? -1 : 1));
    return;
  }
  if (!event.metaKey || event.ctrlKey) return;
  const key = event.key.toLowerCase();
  if (event.altKey && (key === "arrowleft" || key === "arrowright")) {
    event.preventDefault();
    if (isControlled()) return;
    queueTabCommand(() =>
      activateRelativeTab(key === "arrowleft" ? -1 : 1),
    );
  } else if (event.altKey) {
    return;
  } else if (/^[1-9]$/.test(key)) {
    event.preventDefault();
    if (isControlled()) return;
    queueTabCommand(() => activateNumberedTab(Number(key)));
  } else if ((key === "[" || key === "]") && event.shiftKey) {
    event.preventDefault();
    if (isControlled()) return;
    queueTabCommand(() => activateRelativeTab(key === "[" ? -1 : 1));
  } else if (key === "[") {
    event.preventDefault();
    if (isControlled()) return;
    void api.browser.back();
  } else if (key === "]") {
    event.preventDefault();
    if (isControlled()) return;
    void api.browser.forward();
  } else if (key === "l" && !event.shiftKey) {
    event.preventDefault();
    if (isControlled()) return;
    address.focus();
    address.select();
  } else if (key === "t" && !event.shiftKey) {
    event.preventDefault();
    if (isControlled()) return;
    void createNewTab();
  } else if (key === "r") {
    event.preventDefault();
    if (isControlled()) return;
    void api.browser.reload();
  } else if (
    key === "w" &&
    !event.shiftKey &&
    state?.space?.tabs?.length > 1
  ) {
    event.preventDefault();
    if (isControlled()) return;
    void api.browser.closeTab(state.space.activeTabId);
  }
});
api.browser.onChanged(render);
api.browser.onFocusAddress((targetId: string) => {
  if (targetId !== activeTargetId || isControlled()) return;
  address.focus();
  address.select();
});
void api.browser.state().then(render).catch(() => undefined);

function render(next: any) {
  if (!next?.space) return;
  const nextTargetId = String(next.space.activeTabId || "");
  const targetChanged = Boolean(activeTargetId && activeTargetId !== nextTargetId);
  state = next;
  activeTargetId = nextTargetId;
  document.querySelector("#space-name")!.textContent = next.space.name;
  const spaceCount = Math.max(1, Number(next.spaceCount) || 1);
  document.querySelector("#spaces-count")!.textContent =
    spaceCount > 99 ? "99+" : String(spaceCount);
  document.querySelector("#spaces-button")!.setAttribute(
    "aria-label",
    `返回 Spaces，共 ${spaceCount} 个`,
  );
  document.title = next.activeTab?.title || next.space.name || "X-Browser";
  const controlled = next.space.ownership === "agent" && next.space.lifecycle === "active";
  if (targetChanged && pendingNavigation?.targetId !== nextTargetId) {
    pendingNavigation = undefined;
    navigationToken += 1;
    addressShell.classList.remove("navigating");
    form.removeAttribute("aria-busy");
  }
  if (targetChanged && document.activeElement === address) {
    addressEditing = false;
    address.blur();
  }
  if (controlled && document.activeElement === address) {
    addressEditing = false;
    address.blur();
  }
  if (!addressEditing && document.activeElement !== address) {
    address.value =
      pendingNavigation?.targetId === nextTargetId
        ? pendingNavigation.display
        : displayNavigationAddress(next.activeTab?.url);
  }
  back.disabled = controlled || !next.canGoBack;
  forward.disabled = controlled || !next.canGoForward;
  reload.disabled = controlled;
  newTab.disabled = controlled;
  address.disabled = controlled;
  reload.classList.toggle("loading", Boolean(next.loading));
  progress.classList.toggle("loading", Boolean(next.loading));
  document.querySelector("#browser-status")!.textContent = controlled
    ? next.space.agentTask?.detail || "Agent 正在浏览"
    : "";
  document.body.classList.toggle("agent-controlled", controlled);
  lock.classList.toggle("hidden", !controlled);
  renderTabs(next.space.tabs, controlled);
}

function renderTabs(nextTabs: any[], controlled: boolean) {
  const liveIds = new Set(nextTabs.map((tab) => String(tab.targetId)));
  for (const [targetId, button] of tabButtons) {
    if (liveIds.has(targetId)) continue;
    button.remove();
    tabButtons.delete(targetId);
  }
  for (const tab of nextTabs) {
    const targetId = String(tab.targetId);
    let button = tabButtons.get(targetId);
    if (!button) {
      button = tabButton(targetId);
      tabButtons.set(targetId, button);
    }
    button.classList.toggle("active", targetId === state.space.activeTabId);
    button.setAttribute(
      "aria-selected",
      targetId === state.space.activeTabId ? "true" : "false",
    );
    button.disabled = controlled;
    button.querySelector<HTMLElement>(".tab-identity")!.style.setProperty(
      "--site-color",
      siteColor(tab.url),
    );
    button.querySelector<HTMLElement>(".tab-title")!.textContent =
      tab.title || "New Tab";
  }
  const order = nextTabs.map((tab) => String(tab.targetId)).join(",");
  if (tabs.dataset.order !== order) {
    tabs.replaceChildren(
      ...nextTabs.map((tab) => tabButtons.get(String(tab.targetId))!),
    );
    tabs.dataset.order = order;
  }
}

function tabButton(targetId: string) {
  const button = document.createElement("button");
  button.className = "tab";
  button.dataset.targetId = targetId;
  button.setAttribute("role", "tab");
  button.draggable = true;
  const identity = document.createElement("span");
  identity.className = "tab-identity";
  const title = document.createElement("span");
  title.className = "tab-title";
  const close = document.createElement("span");
  close.className = "tab-close";
  close.textContent = "×";
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    queueTabCommand(() => closeTargetTab(targetId));
  });
  button.append(identity, title, close);
  button.addEventListener("click", () =>
    queueTabCommand(() => activateTargetTab(targetId)),
  );
  button.addEventListener("auxclick", (event) => {
    if (event.button !== 1 || isControlled()) return;
    event.preventDefault();
    if ((state?.space?.tabs?.length || 0) < 2) return;
    queueTabCommand(() => closeTargetTab(targetId));
  });
  button.addEventListener("dragstart", (event) => {
    if (isControlled()) {
      event.preventDefault();
      return;
    }
    draggedTargetId = targetId;
    button.classList.add("dragging");
    event.dataTransfer?.setData("text/plain", targetId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  button.addEventListener("dragover", (event) => {
    if (!draggedTargetId || draggedTargetId === targetId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    clearDropIndicator();
    dropTarget = button;
    const rect = button.getBoundingClientRect();
    button.classList.add(
      event.clientX < rect.left + rect.width / 2 ? "drop-before" : "drop-after",
    );
  });
  button.addEventListener("drop", (event) => {
    if (!draggedTargetId || draggedTargetId === targetId) return;
    event.preventDefault();
    const sourceTargetId = draggedTargetId;
    const rect = button.getBoundingClientRect();
    const placeAfter = event.clientX >= rect.left + rect.width / 2;
    const ordered = (state?.space?.tabs || []).filter(
      (tab: any) => tab.targetId !== sourceTargetId,
    );
    let index = ordered.findIndex((tab: any) => tab.targetId === targetId);
    if (placeAfter) index += 1;
    const beforeTargetId = ordered[index]?.targetId || null;
    clearDragState();
    queueTabCommand(() => reorderTargetTab(sourceTargetId, beforeTargetId));
  });
  button.addEventListener("dragend", clearDragState);
  return button;
}

async function submitNavigation(input: string, token: number) {
  try {
    await api.browser.navigate(input);
  } catch (error) {
    if (token !== navigationToken) return;
    pendingNavigation = undefined;
    address.value = currentDisplayAddress();
    address.title = "无法打开该地址，已恢复当前页面";
    addressShell.classList.add("navigation-error");
  } finally {
    if (token !== navigationToken) return;
    pendingNavigation = undefined;
    addressShell.classList.remove("navigating");
    form.removeAttribute("aria-busy");
    try {
      const latest = await api.browser.state();
      if (latest && token === navigationToken) render(latest);
    } catch {
      // State broadcasts will recover the chrome after transient IPC failure.
    }
  }
}

function currentDisplayAddress() {
  return displayNavigationAddress(state?.activeTab?.url);
}

function siteColor(value: string) {
  let host = "x-browser";
  try {
    host = new URL(value).hostname || host;
  } catch {
    // Internal and incomplete URLs use the product color.
  }
  let hash = 0;
  for (const character of host) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const hue = 145 + (hash % 72);
  return `hsl(${hue} 42% 46%)`;
}

function isControlled() {
  return state?.space?.ownership === "agent" && state?.space?.lifecycle === "active";
}

async function createNewTab() {
  if (isControlled()) return;
  const next = await api.browser.createTab();
  if (next?.space) render(next);
  requestAnimationFrame(() => {
    if (isControlled()) return;
    address.focus();
    address.select();
  });
}

async function activateNumberedTab(number: number) {
  const latest = await api.browser.state();
  if (latest?.space) render(latest);
  const nextTabs = latest?.space?.tabs || [];
  if (nextTabs.length === 0) return;
  const index = number === 9 ? nextTabs.length - 1 : number - 1;
  const target = nextTabs[index];
  if (!target || target.targetId === latest.space.activeTabId) return;
  await activateTargetTab(target.targetId);
}

async function activateRelativeTab(direction: -1 | 1) {
  const latest = await api.browser.state();
  if (latest?.space) render(latest);
  const nextTabs = latest?.space?.tabs || [];
  if (nextTabs.length < 2) return;
  const activeIndex = Math.max(
    0,
    nextTabs.findIndex((tab: any) => tab.targetId === latest.space.activeTabId),
  );
  const index = (activeIndex + direction + nextTabs.length) % nextTabs.length;
  await activateTargetTab(nextTabs[index].targetId);
}

async function activateTargetTab(targetId: string) {
  await api.browser.activateTab(targetId);
  const latest = await api.browser.state();
  if (latest?.space) render(latest);
}

async function reorderTargetTab(
  targetId: string,
  beforeTargetId: string | null,
) {
  const next = await api.browser.reorderTab(targetId, beforeTargetId);
  if (next?.space) render(next);
}

async function closeTargetTab(targetId: string) {
  await api.browser.closeTab(targetId);
  const latest = await api.browser.state();
  if (latest?.space) render(latest);
}

function queueTabCommand(command: () => Promise<void>) {
  tabCommandQueue = tabCommandQueue.then(command).catch(() => undefined);
}

function clearDropIndicator() {
  dropTarget?.classList.remove("drop-before", "drop-after");
  dropTarget = undefined;
  tabs.classList.remove("drop-end");
}

function clearDragState() {
  clearDropIndicator();
  if (draggedTargetId) {
    tabButtons.get(draggedTargetId)?.classList.remove("dragging");
  }
  draggedTargetId = "";
}
