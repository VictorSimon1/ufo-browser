const api = (window as any).xBrowser;
const grid = document.querySelector<HTMLElement>("#spaces-grid")!;
const count = document.querySelector<HTMLElement>("#space-count")!;
const cards = new Map<number, HTMLElement>();
const previewStates = new Map<number, PreviewPaintState>();
const create = createCard();
let spaces: any[] = [];
let spacesResolved = false;
let overviewActive = true;
let visibilityFrame = 0;
let visibilityFallback = 0;
let openMenuCard: HTMLElement | undefined;

type PreviewPaintState = {
  drawing: boolean;
  lastRevision: number;
  pending?: { revision: number; data: Uint8Array };
};

const observer = new IntersectionObserver(
  () => scheduleVisibilityPublish(),
  { rootMargin: "120px 0px", threshold: [0, 0.01, 0.5, 1] },
);

document.querySelector("#quick-create")!.addEventListener("click", () =>
  api.overview.create(),
);
document.addEventListener("pointerdown", (event) => {
  const target = event.target as Element | null;
  if (target?.closest(".card-menu")) return;
  closeCardMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !openMenuCard) return;
  const trigger = openMenuCard.querySelector<HTMLButtonElement>(
    ".card-menu-trigger",
  );
  closeCardMenu();
  trigger?.focus();
});

void refresh();
api.overview.onChanged((next: any[]) => {
  spaces = next;
  spacesResolved = true;
  render();
});
api.overview.onPreviewFrame((frame: any) => queuePreviewFrame(frame));

api.onPresentation((presentation: any) => {
  overviewActive = presentation?.kind === "overview";
  if (!overviewActive) {
    if (visibilityFrame) cancelAnimationFrame(visibilityFrame);
    if (visibilityFallback) clearTimeout(visibilityFallback);
    visibilityFrame = 0;
    visibilityFallback = 0;
    return;
  }
  // A frame queued before the native window became visible can remain
  // throttled while its non-zero id prevents a fresh request. Window show and
  // restore re-publish Presentation, so always replace that stale request.
  if (visibilityFrame) cancelAnimationFrame(visibilityFrame);
  if (visibilityFallback) clearTimeout(visibilityFallback);
  visibilityFrame = 0;
  visibilityFallback = 0;
  scheduleVisibilityPublish();
});

window.addEventListener("resize", scheduleVisibilityPublish, { passive: true });
window.addEventListener("scroll", scheduleVisibilityPublish, { passive: true });
document.addEventListener("visibilitychange", scheduleVisibilityPublish);

async function refresh() {
  spaces = await api.overview.list();
  spacesResolved = true;
  render();
}

function render() {
  count.textContent = `${spaces.length} ${spaces.length === 1 ? "space" : "spaces"}`;
  const liveIds = new Set(spaces.map((space) => Number(space.id)));
  for (const [id, card] of cards) {
    if (liveIds.has(id)) continue;
    observer.unobserve(card);
    if (openMenuCard === card) closeCardMenu();
    card.remove();
    cards.delete(id);
    previewStates.delete(id);
  }

  for (const space of spaces) {
    const id = Number(space.id);
    let card = cards.get(id);
    if (!card) {
      card = spaceCard(id);
      cards.set(id, card);
      observer.observe(card);
    }
    updateSpaceCard(card, space);
  }
  const order = spaces.map((space) => Number(space.id)).join(",");
  if (grid.dataset.order !== order) {
    grid.replaceChildren(
      ...spaces.map((space) => cards.get(Number(space.id))!),
      create,
    );
    grid.dataset.order = order;
  }
  scheduleVisibilityPublish();
}

function spaceCard(spaceId: number) {
  const card = document.createElement("article");
  card.className = "space-card";
  card.dataset.spaceId = String(spaceId);
  card.tabIndex = 0;
  card.setAttribute("role", "group");

  const preview = document.createElement("div");
  preview.className = "space-preview";
  preview.innerHTML = `
    <div class="preview-browser-chrome" aria-hidden="true">
      <div class="preview-titlebar">
        <span class="preview-traffic"><i></i><i></i><i></i></span>
        <div class="preview-tabs"></div>
        <span class="preview-tab-add">+</span>
      </div>
      <div class="preview-toolbar">
        <span class="preview-nav preview-nav-back"></span>
        <span class="preview-nav preview-nav-forward"></span>
        <span class="preview-nav preview-nav-reload"></span>
        <span class="preview-address"><i></i><em></em></span>
        <span class="preview-menu"><i></i><i></i><i></i></span>
      </div>
    </div>
    <canvas class="preview-canvas" aria-hidden="true"></canvas>
    <div class="preview-placeholder" aria-hidden="true">
      <div class="placeholder-browser">
        <div class="placeholder-page">
          <span class="placeholder-mark">X</span>
          <strong>New Tab</strong>
          <small>X-Browser Space</small>
          <b></b><b></b><b></b>
        </div>
      </div>
    </div>
  `;

  const info = document.createElement("div");
  info.className = "space-info";
  info.innerHTML = `
    <div class="space-title-line"><strong></strong><input class="space-title-editor" aria-label="Space 名称" maxlength="80" /></div>
    <div class="space-meta"><span></span><span>Chrome · 用户1&nbsp;&nbsp;<b>▢</b> <em></em></span></div>
  `;

  const editor = info.querySelector<HTMLInputElement>(".space-title-editor")!;
  editor.addEventListener("click", (event) => event.stopPropagation());
  editor.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void finishRename(card, true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishRename(card, false);
    }
  });
  editor.addEventListener("blur", () => {
    if (card.classList.contains("renaming")) void finishRename(card, true, false);
  });

  const menu = document.createElement("div");
  menu.className = "card-menu";
  const menuTrigger = document.createElement("button");
  menuTrigger.className = "card-menu-trigger";
  menuTrigger.title = "Space 菜单";
  menuTrigger.setAttribute("aria-label", "打开 Space 菜单");
  menuTrigger.setAttribute("aria-haspopup", "menu");
  menuTrigger.setAttribute("aria-expanded", "false");
  menuTrigger.innerHTML = "<i></i><i></i><i></i>";
  const menuPopover = document.createElement("div");
  menuPopover.className = "card-menu-popover";
  menuPopover.setAttribute("role", "menu");
  menuPopover.hidden = true;

  const rename = document.createElement("button");
  rename.className = "card-menu-item";
  rename.setAttribute("role", "menuitem");
  rename.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.2 13.8-.7 2.7 2.7-.7 8.5-8.5-2-2-8.5 8.5Z"></path><path d="m11.7 6.3 2 2"></path></svg><span>重命名</span><kbd>F2</kbd>`;
  rename.addEventListener("click", (event) => {
    event.stopPropagation();
    beginRename(card);
  });

  const close = document.createElement("button");
  close.className = "card-menu-item danger";
  close.setAttribute("role", "menuitem");
  close.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6h11"></path><path d="m8 3.8.5-1h3l.5 1"></path><path d="m6.1 6 .6 10h6.6l.6-10"></path><path d="M8.8 8.5v5M11.2 8.5v5"></path></svg><span>关闭 Space</span>`;
  close.addEventListener("click", async (event) => {
    event.stopPropagation();
    closeCardMenu();
    card.classList.add("closing");
    try {
      await api.overview.close(Number(card.dataset.spaceId));
    } catch {
      card.classList.remove("closing");
    }
  });

  menuPopover.append(rename, close);
  menu.append(menuTrigger, menuPopover);
  menuTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleCardMenu(card);
  });

  card.append(preview, info, menu);
  const open = async () => {
    if (card.dataset.opening === "1") return;
    if (Number(card.dataset.suppressOpenUntil || 0) > Date.now()) return;
    card.dataset.opening = "1";
    card.classList.add("opening");
    try {
      await api.overview.open(Number(card.dataset.spaceId));
    } finally {
      card.dataset.opening = "0";
      card.classList.remove("opening");
    }
  };
  card.addEventListener("click", () => void open());
  card.addEventListener("keydown", (event) => {
    if (event.target !== card) return;
    if (event.key === "F2") {
      event.preventDefault();
      beginRename(card);
      return;
    }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      openCardMenu(card);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void open();
  });
  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openCardMenu(card);
  });
  return card;
}

function toggleCardMenu(card: HTMLElement) {
  if (openMenuCard === card) closeCardMenu();
  else openCardMenu(card);
}

function openCardMenu(card: HTMLElement) {
  closeCardMenu();
  const menu = card.querySelector<HTMLElement>(".card-menu")!;
  const trigger = card.querySelector<HTMLButtonElement>(".card-menu-trigger")!;
  const popover = card.querySelector<HTMLElement>(".card-menu-popover")!;
  openMenuCard = card;
  menu.classList.add("open");
  trigger.setAttribute("aria-expanded", "true");
  popover.hidden = false;
  requestAnimationFrame(() => popover.classList.add("visible"));
  popover.querySelector<HTMLButtonElement>(".card-menu-item")?.focus();
}

function closeCardMenu() {
  if (!openMenuCard) return;
  const menu = openMenuCard.querySelector<HTMLElement>(".card-menu");
  const trigger = openMenuCard.querySelector<HTMLButtonElement>(
    ".card-menu-trigger",
  );
  const popover = openMenuCard.querySelector<HTMLElement>(
    ".card-menu-popover",
  );
  menu?.classList.remove("open");
  trigger?.setAttribute("aria-expanded", "false");
  popover?.classList.remove("visible");
  if (popover) popover.hidden = true;
  openMenuCard = undefined;
}

function beginRename(card: HTMLElement) {
  closeCardMenu();
  const title = card.querySelector<HTMLElement>(".space-title-line strong")!;
  const editor = card.querySelector<HTMLInputElement>(".space-title-editor")!;
  card.classList.add("renaming");
  editor.value = title.textContent || "";
  editor.dataset.original = editor.value;
  editor.focus();
  editor.select();
}

async function finishRename(
  card: HTMLElement,
  commit: boolean,
  restoreFocus = true,
) {
  if (!card.classList.contains("renaming")) return;
  const editor = card.querySelector<HTMLInputElement>(".space-title-editor")!;
  const value = editor.value.trim();
  const original = editor.dataset.original || "";
  card.classList.remove("renaming");
  card.dataset.suppressOpenUntil = String(Date.now() + 180);
  if (!commit || !value || value === original) {
    editor.value = original;
    if (restoreFocus) card.focus();
    return;
  }
  try {
    await api.overview.rename(Number(card.dataset.spaceId), value);
  } catch {
    editor.value = original;
  }
  if (restoreFocus) card.focus();
}

function updateSpaceCard(card: HTMLElement, space: any) {
  const controlled = space.ownership === "agent" && space.lifecycle === "active";
  const activeTab = space.tabs.find(
    (tab: any) => tab.targetId === space.activeTabId,
  );
  card.dataset.controlled = controlled ? "1" : "0";
  card.setAttribute(
    "aria-label",
    controlled ? `打开 ${space.name}，Agent 正在浏览` : `打开 ${space.name}`,
  );
  card.querySelector(".space-title-line strong")!.textContent = space.name;
  const editor = card.querySelector<HTMLInputElement>(".space-title-editor")!;
  if (!card.classList.contains("renaming")) editor.value = space.name;
  card.querySelector(".space-meta span:first-child")!.textContent = controlled
    ? space.agentTask?.detail || "Agent 正在浏览"
    : activeTab?.title || "Ready";
  card.querySelector(".space-meta em")!.textContent = String(space.tabs.length);
  updatePreviewChrome(card, space, activeTab);
  const placeholder = card.querySelector<HTMLElement>(".preview-placeholder");
  if (placeholder) {
    const host = previewHost(activeTab?.url);
    placeholder.style.setProperty("--placeholder-hue", String(host.hue));
    placeholder.querySelector(".placeholder-mark")!.textContent = host.mark;
    placeholder.querySelector("strong")!.textContent =
      activeTab?.title || "New Tab";
    placeholder.querySelector("small")!.textContent = host.label;
  }
}

function updatePreviewChrome(card: HTMLElement, space: any, activeTab: any) {
  const tabs = card.querySelector<HTMLElement>(".preview-tabs")!;
  const allTabs = Array.isArray(space.tabs) ? space.tabs : [];
  const activeIndex = allTabs.findIndex(
    (tab: any) => tab.targetId === space.activeTabId,
  );
  const tabRecords =
    activeIndex >= 3
      ? [...allTabs.slice(0, 2), allTabs[activeIndex]]
      : allTabs.slice(0, 3);
  const signature = tabRecords
    .map(
      (tab: any) =>
        `${tab.targetId}:${tab.title}:${tab.url}:${tab.targetId === space.activeTabId}`,
    )
    .join("|");
  if (tabs.dataset.signature !== signature) {
    tabs.replaceChildren(
      ...tabRecords.map((tab: any) => {
        const item = document.createElement("span");
        item.className = "preview-tab";
        item.classList.toggle("active", tab.targetId === space.activeTabId);
        const identity = previewHost(tab.url);
        item.style.setProperty("--preview-site-hue", String(identity.hue));
        const mark = document.createElement("i");
        mark.textContent = identity.mark;
        const title = document.createElement("em");
        title.textContent = tab.title || "New Tab";
        item.append(mark, title);
        return item;
      }),
    );
    tabs.dataset.signature = signature;
  }
  const address = card.querySelector<HTMLElement>(".preview-address em")!;
  const identity = previewHost(activeTab?.url);
  address.textContent = previewAddress(activeTab?.url, identity.label);
  card
    .querySelector<HTMLElement>(".preview-address")!
    .style.setProperty("--preview-site-hue", String(identity.hue));
}

function previewAddress(value: unknown, fallback: string) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
    }
    if (url.protocol === "data:") return "Local page";
  } catch {
    // Use the same human-readable host fallback as the placeholder.
  }
  return fallback;
}

function previewHost(value?: string) {
  let label = "X-Browser Space";
  try {
    const url = new URL(value || "");
    label = url.hostname || (url.protocol === "data:" ? "Local page" : label);
  } catch {
    // Keep the product fallback for incomplete or internal URLs.
  }
  let hash = 0;
  for (const character of label) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const first = label.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() || "X";
  return { label, mark: first, hue: 145 + (hash % 58) };
}

function createCard() {
  const card = document.createElement("button");
  card.className = "create-space-card";
  card.innerHTML = '<span><i></i><b></b></span><small>新建 Space</small>';
  card.addEventListener("click", () => api.overview.create());
  return card;
}

function scheduleVisibilityPublish() {
  if (!overviewActive || visibilityFrame) return;
  visibilityFrame = requestAnimationFrame(() => {
    visibilityFrame = 0;
    if (visibilityFallback) clearTimeout(visibilityFallback);
    visibilityFallback = 0;
    publishVisibleCards();
  });
  // macOS may not service a hidden WebContentsView's RAF promptly even after
  // the native window is shown. The bounded fallback keeps cold-start
  // hydration moving without creating a polling loop.
  visibilityFallback = window.setTimeout(() => {
    visibilityFallback = 0;
    if (visibilityFrame) cancelAnimationFrame(visibilityFrame);
    visibilityFrame = 0;
    publishVisibleCards();
  }, 120);
}

function publishVisibleCards() {
  if (!overviewActive) return;
  if (!spacesResolved) return;
  const cardRects = [...cards.entries()]
    .filter(([, card]) => card.isConnected)
    .map(([id, card]) => {
      const rect = card.getBoundingClientRect();
      return {
        id,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      };
    });
  // Main seeds the bounded top-of-grid candidates at native window show.
  // Never erase that seed during the short interval where records are known
  // but their card nodes have not acquired layout rectangles yet.
  if (spaces.length > 0 && cardRects.length === 0) {
    scheduleVisibilityPublish();
    return;
  }
  document.body.dataset.visibilityPublishes = String(
    Number(document.body.dataset.visibilityPublishes || 0) + 1,
  );
  document.body.dataset.visibilityRequest = cardRects
    .map((card) => card.id)
    .join(",");
  void api.overview
    .setVisible(cardRects, {
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    })
    .then(() => {
      document.body.dataset.visibilityAck = "1";
      delete document.body.dataset.visibilityError;
    })
    .catch((error: unknown) => {
      document.body.dataset.visibilityError = String(error);
    });
}

function queuePreviewFrame(frame: any) {
  document.body.dataset.previewFrames = String(
    Number(document.body.dataset.previewFrames || 0) + 1,
  );
  const id = Number(frame?.spaceId);
  const revision = Number(frame?.revision);
  if (!Number.isSafeInteger(id) || !Number.isFinite(revision) || !cards.has(id)) return;
  const data = frameBytes(frame?.data);
  if (data.byteLength === 0) return;
  let state = previewStates.get(id);
  if (!state) {
    state = { drawing: false, lastRevision: -1 };
    previewStates.set(id, state);
  }
  if (revision <= state.lastRevision) return;
  state.pending = { revision, data };
  if (!state.drawing) void paintPendingFrames(id, state);
}

async function paintPendingFrames(spaceId: number, state: PreviewPaintState) {
  state.drawing = true;
  try {
    while (state.pending) {
      const next = state.pending;
      state.pending = undefined;
      if (next.revision <= state.lastRevision) continue;
      const bytes = new Uint8Array(next.data.byteLength);
      bytes.set(next.data);
      const bitmap = await createImageBitmap(
        new Blob([bytes.buffer], { type: "image/jpeg" }),
      );
      try {
        const card = cards.get(spaceId);
        if (!card?.isConnected || next.revision <= state.lastRevision) continue;
        const canvas = card.querySelector<HTMLCanvasElement>(".preview-canvas")!;
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) continue;
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        canvas.classList.add("ready");
        const placeholder = card.querySelector<HTMLElement>(".preview-placeholder");
        if (placeholder && !placeholder.classList.contains("leaving")) {
          requestAnimationFrame(() => placeholder.classList.add("leaving"));
          setTimeout(() => placeholder.remove(), 220);
        }
        state.lastRevision = next.revision;
      } finally {
        bitmap.close();
      }
    }
  } catch (error) {
    document.body.dataset.previewError = String(error);
    // Keep the previous canvas frame and wait for the next bounded update.
  } finally {
    state.drawing = false;
    if (state.pending) void paintPendingFrames(spaceId, state);
  }
}

function frameBytes(value: any): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value?.type === "Buffer" && Array.isArray(value.data)) {
    return Uint8Array.from(value.data);
  }
  return new Uint8Array();
}
