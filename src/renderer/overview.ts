const api = (window as any).xBrowser;
const grid = document.querySelector<HTMLElement>("#spaces-grid")!;
const count = document.querySelector<HTMLElement>("#space-count")!;
const cards = new Map<number, HTMLElement>();
const previewStates = new Map<number, PreviewPaintState>();
const create = createCard();
const profileDialogBackdrop = document.querySelector<HTMLElement>(
  "#profile-dialog-backdrop",
)!;
const profileDialogContent = document.querySelector<HTMLElement>(
  "#profile-dialog-content",
)!;
const profileDialogTitle = document.querySelector<HTMLElement>(
  "#profile-dialog-title",
)!;
const profileDialogSubtitle = document.querySelector<HTMLElement>(
  "#profile-dialog-subtitle",
)!;
const profileSyncStrip = document.querySelector<HTMLElement>(
  "#profile-sync-strip",
)!;
const profileSyncLabel = document.querySelector<HTMLElement>(
  "#profile-sync-label",
)!;
const profileSyncFill = document.querySelector<HTMLElement>(
  "#profile-sync-fill",
)!;
let spaces: any[] = [];
let browserProfiles: any[] = [];
let spacesResolved = false;
let overviewActive = true;
let visibilityFrame = 0;
let visibilityFallback = 0;
let openMenuCard: HTMLElement | undefined;
let profileDialogLocked = false;
let latestSyncProgress: any;
let profileSyncHideTimer = 0;
let createSpacePending = false;
let createProfileMenuGeneration = 0;
let openingSpaceId: number | undefined;
let spaceTransitionSequence = 0;

void api.app.info().then((info: any) => {
  const version = String(info?.version || "").trim();
  if (version) document.querySelector("#app-version")!.textContent = `v${version}`;
});

type PreviewPaintState = {
  drawing: boolean;
  lastRevision: number;
  pending?: { revision: number; data: Uint8Array };
};

const observer = new IntersectionObserver(
  () => scheduleVisibilityPublish(),
  { rootMargin: "120px 0px", threshold: [0, 0.01, 0.5, 1] },
);

document.querySelector("#quick-create")!.addEventListener("click", () => {
  void createSpaceWithProfile(defaultProfile()?.id);
});
document.querySelector("#profile-button")!.addEventListener("click", () => {
  void openProfileDialog();
});
document.querySelector("#profile-dialog-close")!.addEventListener("click", () =>
  closeProfileDialog(),
);
profileDialogBackdrop.addEventListener("pointerdown", (event) => {
  if (event.target === profileDialogBackdrop) closeProfileDialog();
});
api.profiles.onImportProgress((progress: any) => updateImportProgress(progress));
api.profiles.onSyncProgress((progress: any) => updateProfileSyncProgress(progress));
document.addEventListener("pointerdown", (event) => {
  const target = event.target as Element | null;
  if (!target?.closest(".card-menu")) closeCardMenu();
  if (!target?.closest(".create-space-profile-control")) {
    closeCreateProfileMenu();
  }
});
document.addEventListener("focusin", (event) => {
  const target = event.target as Element | null;
  if (
    isCreateProfileMenuOpen() &&
    !target?.closest(".create-space-profile-control")
  ) {
    closeCreateProfileMenu();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!profileDialogBackdrop.hidden) {
    closeProfileDialog();
    return;
  }
  if (isCreateProfileMenuOpen()) {
    closeCreateProfileMenu(true);
    return;
  }
  if (!openMenuCard) return;
  const trigger = openMenuCard.querySelector<HTMLButtonElement>(
    ".card-menu-trigger",
  );
  closeCardMenu();
  trigger?.focus();
});

void Promise.all([refresh(), refreshProfiles()]);
api.overview.onChanged((next: any[]) => {
  spaces = next;
  spacesResolved = true;
  render();
});
api.overview.onPreviewFrame((frame: any) => queuePreviewFrame(frame));

api.onPresentation((presentation: any) => {
  overviewActive = presentation?.kind === "overview";
  renderProfileSyncStrip();
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

async function refreshProfiles() {
  browserProfiles = await api.profiles.list();
  updateProfileButton();
  for (const space of spaces) {
    const card = cards.get(Number(space.id));
    if (card) updateSpaceCard(card, space);
  }
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
          <small>UFO-Browser Space</small>
          <b></b><b></b><b></b>
        </div>
      </div>
    </div>
  `;

  const info = document.createElement("div");
  info.className = "space-info";
  info.innerHTML = `
    <div class="space-title-line"><strong></strong><span class="space-id-badge" title="Agent 调度使用的数字 Space ID"></span><input class="space-title-editor" aria-label="Space 名称" maxlength="80" /></div>
    <div class="space-meta"><span></span><span><b class="space-profile">UFO-Browser</b>&nbsp;&nbsp;<b>▢</b> <em></em></span></div>
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
    if (card.dataset.opening === "1" || openingSpaceId !== undefined) return;
    if (Number(card.dataset.suppressOpenUntil || 0) > Date.now()) return;
    const spaceId = Number(card.dataset.spaceId);
    const previewRect = preview.getBoundingClientRect();
    openingSpaceId = spaceId;
    card.dataset.opening = "1";
    card.classList.add("opening");
    closeCardMenu();
    closeCreateProfileMenu();
    const token = `${spaceId}-${Date.now().toString(36)}-${++spaceTransitionSequence}`;
    try {
      await api.overview.open(spaceId, {
        x: previewRect.x,
        y: previewRect.y,
        width: previewRect.width,
        height: previewRect.height,
        token,
      });
    } catch {
      // The card remains in place when native preparation fails, so clearing
      // the opening state is sufficient to restore interaction.
    } finally {
      openingSpaceId = undefined;
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
  card.querySelector(".space-id-badge")!.textContent = `ID ${space.id}`;
  const editor = card.querySelector<HTMLInputElement>(".space-title-editor")!;
  if (!card.classList.contains("renaming")) editor.value = space.name;
  card.querySelector(".space-meta span:first-child")!.textContent = controlled
    ? space.agentTask?.detail || "Agent 正在浏览"
    : activeTab?.title || "Ready";
  card.querySelector(".space-profile")!.textContent = profileName(space.profileId);
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
  let label = "UFO-Browser Space";
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
  const card = document.createElement("article");
  card.className = "create-space-card";
  card.innerHTML = `
    <button class="create-space-main" aria-label="使用默认 Profile 新建 Space">
      <span class="create-space-plus" aria-hidden="true"><i></i><b></b></span>
    </button>
    <div class="create-space-profile-control">
      <button class="create-space-profile-trigger" aria-label="选择用于新 Space 的 Profile" aria-haspopup="menu" aria-controls="create-profile-popover" aria-expanded="false">
        <span class="profile-avatar create-space-profile-avatar">U</span>
        <span class="create-space-profile-label">UFO-Browser</span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6.5 8 3.5 3.5L13.5 8"></path></svg>
      </button>
      <div id="create-profile-popover" class="create-profile-popover" role="menu" hidden></div>
    </div>
  `;
  card
    .querySelector<HTMLButtonElement>(".create-space-main")!
    .addEventListener("click", () => {
      void createSpaceWithProfile(defaultProfile()?.id);
    });
  const profileTrigger = card.querySelector<HTMLButtonElement>(
    ".create-space-profile-trigger",
  )!;
  profileTrigger.addEventListener("click", (event) => {
      event.stopPropagation();
      void toggleCreateProfileMenu();
    });
  profileTrigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    if (isCreateProfileMenuOpen()) {
      focusCreateProfileOption(0);
      return;
    }
    void toggleCreateProfileMenu(true);
  });
  card
    .querySelector<HTMLElement>(".create-profile-popover")!
    .addEventListener("keydown", navigateCreateProfileMenu);
  return card;
}

function defaultProfile() {
  return browserProfiles.find((profile) => profile.isDefault) ?? browserProfiles[0];
}

async function createSpaceWithProfile(profileId?: string) {
  if (createSpacePending) return;
  createSpacePending = true;
  closeCreateProfileMenu();
  closeCardMenu();
  updateCreateCard();
  try {
    await api.overview.create(undefined, profileId);
  } catch {
    create.classList.add("create-failed");
    window.setTimeout(() => create.classList.remove("create-failed"), 320);
  } finally {
    createSpacePending = false;
    updateCreateCard();
  }
}

async function toggleCreateProfileMenu(focusFirst = false) {
  if (createSpacePending) return;
  const trigger = create.querySelector<HTMLButtonElement>(
    ".create-space-profile-trigger",
  )!;
  if (trigger.classList.contains("loading")) {
    closeCreateProfileMenu(true);
    return;
  }
  if (isCreateProfileMenuOpen()) {
    closeCreateProfileMenu(true);
    return;
  }
  closeCardMenu();
  const generation = ++createProfileMenuGeneration;
  trigger.classList.add("loading");
  try {
    await refreshProfiles();
  } catch {
    // Keep the last known local Profile list if the refresh is interrupted.
  } finally {
    if (generation === createProfileMenuGeneration) {
      trigger.classList.remove("loading");
    }
  }
  if (generation !== createProfileMenuGeneration || createSpacePending) return;
  renderCreateProfileMenu();
  const popover = create.querySelector<HTMLElement>(".create-profile-popover")!;
  popover.hidden = false;
  create.classList.add("profile-menu-open");
  trigger.setAttribute("aria-expanded", "true");
  if (focusFirst) focusCreateProfileOption(0);
}

function renderCreateProfileMenu() {
  const popover = create.querySelector<HTMLElement>(".create-profile-popover")!;
  popover.replaceChildren();

  const heading = document.createElement("div");
  heading.className = "create-profile-heading";
  heading.textContent = "使用其他个人资料创建 Space";
  popover.append(heading);

  for (const profile of browserProfiles) {
    const option = document.createElement("button");
    option.className = "create-profile-option";
    option.type = "button";
    option.setAttribute("role", "menuitem");
    option.dataset.profileId = String(profile.id);
    option.innerHTML = `
      <span class="profile-avatar create-profile-option-avatar"></span>
      <span class="create-profile-option-name"></span>
      <small></small>
    `;
    renderProfileAvatar(
      option.querySelector<HTMLElement>(".create-profile-option-avatar")!,
      profile,
    );
    option.querySelector<HTMLElement>(".create-profile-option-name")!.textContent =
      profile.name;
    option.querySelector("small")!.textContent = profile.isDefault ? "默认" : "";
    option.addEventListener("click", (event) => {
      event.stopPropagation();
      void createSpaceWithProfile(profile.id);
    });
    popover.append(option);
  }
}

function navigateCreateProfileMenu(event: KeyboardEvent) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const options = [
    ...create.querySelectorAll<HTMLButtonElement>(".create-profile-option"),
  ];
  if (!options.length) return;
  event.preventDefault();
  const current = options.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "Home") {
    options[0].focus();
    return;
  }
  if (event.key === "End") {
    options.at(-1)!.focus();
    return;
  }
  const direction = event.key === "ArrowDown" ? 1 : -1;
  const next = current < 0
    ? direction > 0 ? 0 : options.length - 1
    : (current + direction + options.length) % options.length;
  options[next].focus();
}

function focusCreateProfileOption(index: number) {
  create
    .querySelectorAll<HTMLButtonElement>(".create-profile-option")
    .item(index)
    ?.focus();
}

function isCreateProfileMenuOpen() {
  return !create.querySelector<HTMLElement>(".create-profile-popover")!.hidden;
}

function closeCreateProfileMenu(restoreFocus = false) {
  const popover = create.querySelector<HTMLElement>(".create-profile-popover")!;
  const trigger = create.querySelector<HTMLButtonElement>(
    ".create-space-profile-trigger",
  )!;
  const opening = trigger.classList.contains("loading");
  if (popover.hidden && !opening) return;
  createProfileMenuGeneration += 1;
  popover.hidden = true;
  create.classList.remove("profile-menu-open");
  trigger.classList.remove("loading");
  trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger.focus();
}

async function openProfileDialog() {
  profileDialogLocked = false;
  profileDialogBackdrop.hidden = false;
  document.body.classList.add("dialog-open");
  profileDialogTitle.textContent = "浏览器 Profile";
  profileDialogSubtitle.textContent = "新 Space 将使用所选登录状态";
  profileDialogContent.innerHTML = '<div class="dialog-loading"><i></i><span>正在读取 Profile</span></div>';
  try {
    await refreshProfiles();
    renderProfileHome();
  } catch {
    renderDialogError("无法读取浏览器 Profile");
  }
  document.querySelector<HTMLButtonElement>("#profile-dialog-close")?.focus();
}

function closeProfileDialog() {
  if (profileDialogLocked || profileDialogBackdrop.hidden) return;
  profileDialogBackdrop.hidden = true;
  document.body.classList.remove("dialog-open");
  profileDialogContent.replaceChildren();
  document.querySelector<HTMLButtonElement>("#profile-button")?.focus();
}

function renderProfileHome() {
  profileDialogTitle.textContent = "浏览器 Profile";
  profileDialogSubtitle.textContent = "新 Space 将使用所选登录状态";
  profileDialogContent.replaceChildren();

  const profilesSection = document.createElement("section");
  profilesSection.className = "dialog-section";
  const heading = document.createElement("h2");
  heading.textContent = "Profile";
  const list = document.createElement("div");
  list.className = "profile-list";
  for (const profile of browserProfiles) {
    const row = document.createElement("div");
    row.className = "profile-row";
    row.dataset.profileId = String(profile.id);
    row.classList.toggle("selected", profile.isDefault);
    const select = document.createElement("button");
    select.className = "profile-row-select";
    select.innerHTML = `
      <span class="profile-row-avatar"></span>
      <span class="profile-row-copy"><strong></strong><small></small></span>
      <span class="profile-row-check" aria-hidden="true">✓</span>
    `;
    renderProfileAvatar(
      select.querySelector<HTMLElement>(".profile-row-avatar")!,
      profile,
    );
    select.querySelector("strong")!.textContent = profile.name;
    select.querySelector("small")!.textContent = profileDetail(profile);
    select.setAttribute(
      "aria-label",
      profile.isDefault ? `${profile.name}，当前默认` : `将 ${profile.name} 设为默认`,
    );
    select.addEventListener("click", async () => {
      if (profile.isDefault) return;
      select.disabled = true;
      try {
        await api.profiles.setDefault(profile.id);
        await refreshProfiles();
        renderProfileHome();
      } catch {
        select.disabled = false;
      }
    });
    row.append(select);
    const clone = document.createElement("button");
    clone.className = "profile-row-clone";
    clone.title = "克隆这个 Profile";
    clone.setAttribute("aria-label", `克隆 ${profile.name}`);
    clone.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6.5" y="6.5" width="9" height="9" rx="2"></rect><path d="M5 13.5H4.5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2V5"></path></svg>';
    clone.addEventListener("click", () => renderCloneProfile(profile));
    row.append(clone);
    if (profile.kind === "imported") {
      const sync = document.createElement("button");
      const syncEnabled = profile.source?.loginSyncEnabled === true;
      sync.className = "profile-sync-toggle";
      sync.title = syncEnabled ? "关闭自动登录态同步" : "开启自动登录态同步";
      sync.setAttribute("role", "switch");
      sync.setAttribute("aria-checked", String(syncEnabled));
      sync.setAttribute(
        "aria-label",
        `${syncEnabled ? "关闭" : "开启"} ${profile.name} 的自动登录态同步`,
      );
      sync.innerHTML = "<i></i>";
      sync.addEventListener("click", async () => {
        sync.disabled = true;
        try {
          await api.profiles.setSync(profile.id, !syncEnabled);
          await refreshProfiles();
          renderProfileHome();
        } catch {
          sync.disabled = false;
        }
      });
      row.append(sync);
      const remove = document.createElement("button");
      remove.className = "profile-row-remove";
      remove.title = "删除导入的 Profile";
      remove.setAttribute("aria-label", `删除 ${profile.name}`);
      remove.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6h11"></path><path d="m8 3.8.5-1h3l.5 1"></path><path d="m6.1 6 .6 10h6.6l.6-10"></path><path d="M8.8 8.5v5M11.2 8.5v5"></path></svg>';
      remove.addEventListener("click", async () => {
        if (!window.confirm(`删除 ${profile.name}？现有登录状态将从 UFO-Browser 移除。`)) return;
        remove.disabled = true;
        try {
          await api.profiles.remove(profile.id);
          await refreshProfiles();
          renderProfileHome();
        } catch (error) {
          remove.disabled = false;
          renderDialogError(
            String(error).includes("profile-in-use")
              ? "这个 Profile 仍被 Space 使用，请先关闭相关 Space"
              : "无法删除这个 Profile",
            "返回",
            renderProfileHome,
          );
        }
      });
      row.append(remove);
    }
    list.append(row);
  }
  profilesSection.append(heading, list);

  const importSection = document.createElement("section");
  importSection.className = "dialog-section import-command-section";
  const importButton = document.createElement("button");
  importButton.className = "import-command";
  importButton.innerHTML = `
    <span class="chrome-mark" aria-hidden="true"><i></i></span>
    <span><strong>从 Chrome 导入登录状态</strong><small>Cookie 与网站存储，仅保存在这台 Mac</small></span>
    <b aria-hidden="true">›</b>
  `;
  importButton.addEventListener("click", () => void renderChromeDiscovery());
  importSection.append(importButton);

  const syncNote = document.createElement("p");
  syncNote.className = "profile-sync-note";
  syncNote.textContent =
    "克隆 Profile 可独立开启自动同步；仅在来源真正变化时更新差异，UFO-Browser 内主动退出的登录不会被旧状态恢复。";
  importSection.append(syncNote);
  profileDialogContent.append(profilesSection, importSection);
}

async function renderChromeDiscovery() {
  profileDialogTitle.textContent = "从 Chrome 导入";
  profileDialogSubtitle.textContent = "不会修改 Chrome，也不会导入密码或浏览记录";
  profileDialogContent.innerHTML = '<div class="dialog-loading"><i></i><span>正在查找 Google Chrome Profile</span></div>';
  try {
    const discovery = await api.profiles.discoverChrome();
    renderChromeProfiles(discovery);
  } catch {
    renderDialogError("无法读取 Google Chrome Profile", "返回", renderProfileHome);
  }
}

function renderChromeProfiles(discovery: any) {
  profileDialogContent.replaceChildren();
  if (!Array.isArray(discovery?.profiles) || discovery.profiles.length === 0) {
    renderDialogError("没有找到可导入的 Google Chrome Profile", "返回", renderProfileHome);
    return;
  }
  const runningNotice = document.createElement("div");
  runningNotice.className = `source-status ${discovery.running ? "warning" : "ready"}`;
  runningNotice.innerHTML = discovery.running
    ? '<span><strong>Google Chrome 正在运行</strong><small>完整导入前需要正常退出 Chrome</small></span>'
    : '<span><strong>可以开始导入</strong><small>macOS 将在下一步请求 Keychain 授权</small></span>';
  if (discovery.running) {
    const quit = document.createElement("button");
    quit.className = "secondary-button compact";
    quit.textContent = "退出 Chrome 并继续";
    quit.addEventListener("click", async () => {
      quit.disabled = true;
      quit.textContent = "正在退出";
      try {
        await api.profiles.quitChrome();
        await renderChromeDiscovery();
      } catch {
        quit.disabled = false;
        quit.textContent = "重新检测";
      }
    });
    runningNotice.append(quit);
  }

  const form = document.createElement("form");
  form.className = "chrome-import-form";
  const choices = document.createElement("div");
  choices.className = "chrome-profile-list";
  const preferred =
    discovery.profiles.find((profile: any) => profile.isLastUsed) ??
    discovery.profiles[0];
  for (const profile of discovery.profiles) {
    const label = document.createElement("label");
    label.className = "chrome-profile-row";
    label.innerHTML = `
      <input type="radio" name="chrome-profile" />
      <span class="profile-row-avatar chrome"></span>
      <span class="profile-row-copy"><strong></strong><small></small></span>
      <span class="radio-indicator"><i></i></span>
    `;
    const input = label.querySelector<HTMLInputElement>("input")!;
    input.value = profile.profileDirName;
    input.checked = profile.profileDirName === preferred.profileDirName;
    label.querySelector(".profile-row-avatar")!.textContent = profileInitial(
      profile.displayName,
    );
    label.querySelector("strong")!.textContent = profile.displayName;
    label.querySelector("small")!.textContent = [
      profile.profileDirName,
      formatProfileLastUsed(profile),
      formatBytes(profile.approximateImportBytes),
    ]
      .filter(Boolean)
      .join(" · ");
    choices.append(label);
  }

  const scopeNote = document.createElement("p");
  scopeNote.className = "import-scope-note";
  scopeNote.textContent =
    "仅在这台 Mac 复制网站登录状态；Chrome 临时会话 Cookie 将保留 30 天。不会导入密码、信用卡、浏览记录或 Google 同步账号。Passkey、设备绑定或客户端证书网站可能需要重新登录。";

  const defaultChoice = document.createElement("label");
  defaultChoice.className = "default-profile-choice";
  defaultChoice.innerHTML = '<input type="checkbox" checked /><span><i>✓</i></span><b>设为新 Task Space 的默认 Profile</b>';
  const partialChoice = document.createElement("label");
  partialChoice.className = "default-profile-choice partial-import-choice";
  partialChoice.innerHTML = '<input type="checkbox" /><span><i>✓</i></span><b>若少量数据无法安全迁移，仍创建部分导入 Profile</b>';
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "secondary-button";
  back.textContent = "返回";
  back.addEventListener("click", renderProfileHome);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary-button";
  submit.textContent = discovery.running ? "等待 Chrome 退出" : "导入登录状态";
  submit.disabled = Boolean(discovery.running);
  actions.append(back, submit);
  form.append(choices, scopeNote, defaultChoice, partialChoice, actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = form.querySelector<HTMLInputElement>(
      'input[name="chrome-profile"]:checked',
    );
    if (!selected) return;
    void runChromeImport(
      selected.value,
      defaultChoice.querySelector<HTMLInputElement>("input")!.checked,
      partialChoice.querySelector<HTMLInputElement>("input")!.checked,
    );
  });
  profileDialogContent.append(runningNotice, form);
}

async function runChromeImport(
  profileDirName: string,
  makeDefault: boolean,
  allowPartial: boolean,
) {
  profileDialogLocked = true;
  profileDialogTitle.textContent = "正在导入登录状态";
  profileDialogSubtitle.textContent = "数据始终保留在这台 Mac";
  profileDialogContent.innerHTML = importProgressMarkup();
  updateImportProgress({ phase: "snapshotting", completed: 0, total: 4 });
  try {
    const result = await api.profiles.importChrome(
      profileDirName,
      makeDefault,
      allowPartial,
    );
    profileDialogLocked = false;
    await refreshProfiles();
    renderImportResult(result);
  } catch (error) {
    profileDialogLocked = false;
    profileDialogTitle.textContent = "导入未完成";
    profileDialogSubtitle.textContent = "现有 UFO-Browser 数据未受影响";
    renderDialogError(importErrorMessage(error), "返回", () => {
      void renderChromeDiscovery();
    });
  }
}

function importProgressMarkup() {
  return `
    <div class="import-progress-view">
      <div class="import-progress-ring"><i></i><span id="import-progress-number">0%</span></div>
      <strong id="import-progress-title">正在准备 Chrome 快照</strong>
      <span id="import-progress-detail">正在建立受保护的本地副本</span>
      <div class="import-progress-track"><i id="import-progress-fill"></i></div>
      <div class="import-progress-steps">
        <span data-phase="snapshotting">快照</span>
        <span data-phase="importing-cookies">Cookie</span>
        <span data-phase="verifying">验证</span>
        <span data-phase="committed">完成</span>
      </div>
    </div>
  `;
}

function updateImportProgress(progress: any) {
  if (!profileDialogLocked || !document.querySelector("#import-progress-fill")) return;
  const completed = Math.max(0, Number(progress?.completed) || 0);
  const total = Math.max(1, Number(progress?.total) || 4);
  const percent = Math.min(100, Math.round((completed / total) * 100));
  const phase = String(progress?.phase || "snapshotting");
  const copy: Record<string, [string, string]> = {
    snapshotting: ["正在准备 Chrome 快照", "正在建立受保护的本地副本"],
    "importing-cookies": ["正在导入 Cookie", "等待或处理 macOS Keychain 授权"],
    verifying: ["正在验证登录状态", "逐项核对 Cookie 与分区属性"],
    committed: ["导入完成", "新的 Profile 已可用于 Task Space"],
  };
  const snapshotDetails: Record<string, string> = {
    preparing: "正在检查可安全迁移的数据",
    compatibility: "正在验证 Chromium 存储格式兼容性",
    Cookies: "正在复制 Chrome Cookie 数据库",
    "Local Storage": "正在复制 Local Storage",
    IndexedDB: "正在复制 IndexedDB",
    WebStorage: "正在复制 WebStorage",
    "File System": "正在复制 File System / OPFS",
    Storage: "正在复制存储元数据",
    QuotaManager: "正在复制配额元数据",
    "QuotaManager-journal": "正在复制配额日志",
    "Service Worker": "正在复制兼容的 Service Worker 数据",
  };
  const [title, defaultDetail] = copy[phase] ?? copy.snapshotting;
  const detail =
    phase === "snapshotting"
      ? snapshotDetails[String(progress?.detailCode || "")] ?? defaultDetail
      : defaultDetail;
  document.querySelector<HTMLElement>("#import-progress-number")!.textContent = `${percent}%`;
  document.querySelector<HTMLElement>("#import-progress-title")!.textContent = title;
  document.querySelector<HTMLElement>("#import-progress-detail")!.textContent = detail;
  document.querySelector<HTMLElement>("#import-progress-fill")!.style.width = `${percent}%`;
  const order = ["snapshotting", "importing-cookies", "verifying", "committed"];
  const index = Math.max(0, order.indexOf(phase));
  document.querySelectorAll<HTMLElement>(".import-progress-steps span").forEach((step, stepIndex) => {
    step.classList.toggle("active", stepIndex <= index);
  });
}

function renderImportResult(result: any) {
  profileDialogTitle.textContent = result?.status === "partial" ? "登录状态已部分导入" : "登录状态已导入";
  profileDialogSubtitle.textContent = result?.profile?.name || "Chrome Profile";
  profileDialogContent.innerHTML = `
    <div class="import-result-view">
      <span class="result-mark">✓</span>
      <strong></strong>
      <small></small>
      <div class="import-result-stats">
        <span><b>${Number(result?.cookies?.imported) || 0}</b><small>Cookie</small></span>
        <span><b>${Number(result?.cookies?.partitioned) || 0}</b><small>CHIPS</small></span>
        <span><b>${Array.isArray(result?.storage?.copied) ? result.storage.copied.length : 0}</b><small>存储类型</small></span>
        <span><b>${result?.profile?.isDefault === true ? "是" : "否"}</b><small>默认 Profile</small></span>
      </div>
      <button class="primary-button">完成</button>
    </div>
  `;
  profileDialogContent.querySelector(".import-result-view > strong")!.textContent =
    result?.status === "partial"
      ? "部分网站可能需要重新登录"
      : "大多数网站可在新 Space 使用这份登录状态";
  const warningLabels = [
    ...(Array.isArray(result?.cookies?.warningCodes)
      ? result.cookies.warningCodes
      : []),
    ...(Array.isArray(result?.storage?.warningCodes)
      ? result.storage.warningCodes
      : []),
  ]
    .map((warning: any) => importWarningLabel(String(warning?.code || "")))
    .filter(Boolean);
  profileDialogContent.querySelector(".import-result-view > small")!.textContent =
    `${Number(result?.cookies?.skipped) || 0} 项已过期或无法安全迁移${
      warningLabels.length ? `；${[...new Set(warningLabels)].join("、")}` : ""
    }`;
  profileDialogContent.querySelector("button")!.addEventListener("click", () => {
    renderProfileHome();
  });
}

function renderDialogError(
  message: string,
  actionLabel = "关闭",
  action: () => void = closeProfileDialog,
) {
  profileDialogLocked = false;
  profileDialogContent.innerHTML = `
    <div class="dialog-error-view">
      <span>!</span>
      <strong></strong>
      <button class="secondary-button"></button>
    </div>
  `;
  profileDialogContent.querySelector("strong")!.textContent = message;
  const button = profileDialogContent.querySelector<HTMLButtonElement>("button")!;
  button.textContent = actionLabel;
  button.addEventListener("click", action);
}

function updateProfileButton() {
  const selected = defaultProfile();
  if (!selected) return;
  renderProfileAvatar(
    document.querySelector<HTMLElement>("#profile-avatar")!,
    selected,
  );
  document.querySelector("#profile-button-label")!.textContent = selected.name;
  updateCreateCard();
}

function updateCreateCard() {
  const selected = defaultProfile();
  const main = create.querySelector<HTMLButtonElement>(".create-space-main")!;
  const trigger = create.querySelector<HTMLButtonElement>(
    ".create-space-profile-trigger",
  )!;
  const quickCreate = document.querySelector<HTMLButtonElement>("#quick-create")!;
  main.disabled = createSpacePending;
  trigger.disabled = createSpacePending || !selected;
  quickCreate.disabled = createSpacePending;
  create.dataset.busy = createSpacePending ? "1" : "0";
  if (!selected) return;
  renderProfileAvatar(
    create.querySelector<HTMLElement>(".create-space-profile-avatar")!,
    selected,
  );
  create.querySelector<HTMLElement>(".create-space-profile-label")!.textContent =
    selected.name;
  main.setAttribute("aria-label", `使用 ${selected.name} 新建 Space`);
  trigger.setAttribute("aria-label", `当前 Profile：${selected.name}；选择其他 Profile`);
}

function renderProfileAvatar(element: HTMLElement, profile: any) {
  element.replaceChildren();
  const source = String(profile?.avatarDataUrl || "");
  if (source.startsWith("data:image/")) {
    const image = document.createElement("img");
    image.src = source;
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    element.append(image);
    element.classList.add("has-image");
    return;
  }
  element.classList.remove("has-image");
  element.textContent = profileInitial(profile?.name);
}

function renderCloneProfile(sourceProfile: any) {
  profileDialogTitle.textContent = "克隆 UFO-Browser Profile";
  profileDialogSubtitle.textContent = `以 ${sourceProfile.name} 作为独立登录态来源`;
  profileDialogContent.innerHTML = `
    <form class="create-space-form profile-clone-form">
      <label><span>名称</span><input name="name" maxlength="160" /></label>
      <p class="import-scope-note">Cookie 与网站登录存储会复制到新的独立 Profile；以后可从直接来源增量同步，两个 Profile 的标签页和 Space 始终隔离。</p>
      <label class="default-profile-choice"><input name="default" type="checkbox" /><span><i>✓</i></span><b>设为新 Space 的默认 Profile</b></label>
      <label class="default-profile-choice"><input name="sync" type="checkbox" /><span><i>✓</i></span><b>克隆后自动同步来源的登录状态</b></label>
      <div class="dialog-actions"><button type="button" class="secondary-button">返回</button><button type="submit" class="primary-button">开始克隆</button></div>
    </form>
  `;
  const form = profileDialogContent.querySelector<HTMLFormElement>("form")!;
  const name = form.querySelector<HTMLInputElement>('input[name="name"]')!;
  name.value = `${sourceProfile.name} 副本`;
  form.querySelector<HTMLButtonElement>('button[type="button"]')!.addEventListener(
    "click",
    renderProfileHome,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.disabled = true;
    profileDialogLocked = true;
    profileDialogSubtitle.textContent = "正在复制登录状态，主窗口可继续响应";
    try {
      await api.profiles.cloneUfo(
        sourceProfile.id,
        name.value.trim(),
        form.querySelector<HTMLInputElement>('input[name="default"]')!.checked,
        form.querySelector<HTMLInputElement>('input[name="sync"]')!.checked,
      );
      profileDialogLocked = false;
      await refreshProfiles();
      renderProfileHome();
    } catch {
      profileDialogLocked = false;
      renderDialogError("无法安全克隆这个 Profile", "返回", renderProfileHome);
    }
  });
  name.focus();
  name.select();
}

function profileDetail(profile: any) {
  if (profile?.kind !== "imported") return "UFO-Browser 本地 Profile";
  const source =
    profile?.source?.type === "ufo"
      ? `来自 ${profile.source?.displayName || "UFO-Browser Profile"}`
      : "来自 Google Chrome";
  const imported =
    profile?.source?.lastImportStatus === "partial" ? "部分导入" : "已克隆";
  if (profile?.source?.loginSyncEnabled !== true) {
    return `${source} · ${imported} · 自动同步关闭`;
  }
  const status = profile?.syncStatus;
  const resultLabels: Record<string, string> = {
    unchanged: "已是最新",
    baselined: "同步基线已建立",
    updated: "刚刚更新",
    conflict: "已保留 UFO 当前登录",
    skipped: "网站存储将在来源空闲后的下次启动同步",
    error: "稍后自动重试",
  };
  const phaseLabels: Record<string, string> = {
    scanning: "正在检查变化",
    comparing: "正在比较差异",
    applying: "正在更新登录状态",
  };
  return `${source} · ${
    phaseLabels[status?.phase] || resultLabels[status?.result] || "自动同步开启"
  }`;
}

function updateProfileSyncProgress(progress: any) {
  document.body.dataset.profileSyncPhase = String(progress?.phase || "");
  document.body.dataset.profileSyncResult = String(progress?.result || "");
  document.body.dataset.profileSyncDetail = String(progress?.detailCode || "");
  if (progress?.detailCode === "storage") {
    document.body.dataset.profileSyncStorageSeen = "1";
  }
  const profileId = String(progress?.profileId || "");
  const profile = browserProfiles.find((candidate) => candidate.id === profileId);
  if (profile) {
    profile.syncStatus = { ...progress };
    const row = profileDialogContent.querySelector<HTMLElement>(
      `.profile-row[data-profile-id="${CSS.escape(profileId)}"]`,
    );
    if (row) {
      const detail = row.querySelector<HTMLElement>(".profile-row-copy small");
      if (detail) detail.textContent = profileDetail(profile);
    }
  }
  latestSyncProgress = progress;
  renderProfileSyncStrip();
}

function renderProfileSyncStrip() {
  if (profileSyncHideTimer) {
    clearTimeout(profileSyncHideTimer);
    profileSyncHideTimer = 0;
  }
  const progress = latestSyncProgress;
  if (!overviewActive || !progress) {
    profileSyncStrip.hidden = true;
    profileSyncStrip.classList.remove("running");
    return;
  }
  const phase = String(progress.phase || "");
  const active = ["scanning", "comparing", "applying"].includes(phase);
  const labels: Record<string, string> = {
    scanning:
      progress.detailCode === "storage"
        ? "正在无感检查网站存储"
        : "正在无感检查登录状态",
    comparing: "正在比较登录状态差异",
    applying:
      progress.detailCode === "storage"
        ? "正在更新变化的网站存储"
        : "正在更新变化的登录状态",
    unchanged: "登录状态已是最新",
    baselined: "自动同步已开启",
    updated: "登录状态已更新",
    conflict: "已保留 UFO-Browser 当前登录",
    skipped: "网站存储将在来源空闲后的下次启动同步",
    error: "登录状态同步稍后自动重试",
    disabled: "自动同步已关闭",
  };
  const percent = active
    ? Math.max(
        0.08,
        Math.min(0.94, Number(progress.completed || 0) / Number(progress.total || 4)),
      )
    : 1;
  profileSyncStrip.hidden = false;
  profileSyncStrip.classList.toggle("running", active);
  profileSyncLabel.textContent = labels[phase] || labels[progress.result] || "登录状态同步";
  profileSyncFill.style.transform = `scaleX(${percent})`;
  if (!active) {
    profileSyncHideTimer = window.setTimeout(() => {
      profileSyncStrip.hidden = true;
      profileSyncStrip.classList.remove("running");
      profileSyncHideTimer = 0;
    }, phase === "error" ? 2800 : 1800);
  }
}

function profileName(profileId: string) {
  return (
    browserProfiles.find((profile) => profile.id === profileId)?.name ??
    (profileId === "default" ? "UFO-Browser" : "Profile")
  );
}

function profileInitial(name: string) {
  return String(name || "U").match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() || "U";
}

function formatBytes(value: unknown) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatProfileLastUsed(profile: any) {
  const activeAt = Number(profile?.activeAt);
  if (!Number.isFinite(activeAt) || activeAt <= 0) {
    return profile?.isLastUsed ? "最近使用" : "";
  }
  const date = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(activeAt));
  return profile?.isLastUsed ? `最近使用 ${date}` : `上次使用 ${date}`;
}

function importWarningLabel(code: string) {
  const labels: Record<string, string> = {
    "expired-cookie": "已跳过过期 Cookie",
    "unsupported-encryption": "存在暂不支持的 Cookie 加密格式",
    "decryption-failed": "部分 Cookie 无法解密",
    "host-digest-mismatch": "部分 Cookie 主机校验失败",
    "invalid-utf8": "部分 Cookie 文本格式无效",
    "invalid-cookie-row": "存在无效 Cookie 记录",
    "service-worker-version-mismatch": "Service Worker 版本不兼容，已跳过",
    "service-worker-copy-failed": "Service Worker 数据无法安全复制，已跳过",
    "local-storage-incompatible": "Local Storage 格式不兼容，已跳过",
    "indexeddb-incompatible": "IndexedDB 格式不兼容，已跳过",
    "file-system-incompatible": "File System / OPFS 格式不兼容，已跳过",
    "storage-metadata-incompatible": "站点存储元数据不兼容，已跳过",
    "service-worker-incompatible": "Service Worker 数据未通过兼容性验证，已跳过",
    "origin-storage-preflight-failed": "站点存储兼容性验证失败，已安全跳过",
  };
  return labels[code] || "";
}

function importErrorMessage(error: unknown) {
  const value = String(error);
  if (value.includes("chrome-running")) return "Google Chrome 仍在运行";
  if (value.includes("chrome-import-in-progress")) return "已有 Chrome 导入正在进行，请等待完成";
  if (value.includes("chrome-discovery-failed")) return "无法读取 Chrome Profile，请检查本机访问权限";
  if (value.includes("chrome-quit-failed")) return "无法正常退出 Google Chrome，请手动退出后重试";
  if (value.includes("keychain-canceled")) return "已取消 macOS Keychain 授权";
  if (value.includes("keychain-item-missing")) return "没有找到 Chrome Safe Storage";
  if (value.includes("cookie-decryption-failed")) {
    return "无法解密 Chrome Cookie，现有 UFO-Browser 数据未受影响";
  }
  if (value.includes("cookie-verification-failed")) return "Cookie 验证未通过，现有 Profile 未受影响";
  if (value.includes("partial-import-not-approved")) {
    return "检测到只能部分迁移的数据；未创建 Profile，因为你没有允许部分导入";
  }
  if (value.includes("chrome-profile-not-found")) return "Chrome Profile 已发生变化，请重新检测";
  return "导入没有完成，现有 UFO-Browser 数据未受影响";
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
      const preview = card.querySelector<HTMLElement>(".space-preview");
      const rect = (preview ?? card).getBoundingClientRect();
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
