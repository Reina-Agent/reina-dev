// ComposerPickers — React port of the legacy actions/agent-config.js composer
// picker UI (mode + effort / model + "more models" modal). Faithful port:
// reproduces the EXACT legacy DOM (same class
// names/ids/structure) and reuses the already-linked legacy composer.css.
//
// Design mirrors HitlDock: React renders ONLY the static shell (the two
// `.select-button`s + the shared `#composer-popover` element). The popover
// CONTENT is built imperatively — byte-for-byte the same `createElement` /
// innerHTML the legacy `openModePopover` produces — so the popover stays
// identical to legacy with zero re-implementation drift. The
// button labels/titles/`body.dataset.mode` are driven from the agentSettings
// store via `useAgentSettings` (mirror of `applyComposerLabels`).
//
// The "more models" modal is the legacy `openModelPickerModal`: a separate
// `#composer-model-modal` element appended to `document.body`. It is built
// imperatively here too (identical markup) and torn down on close.
//
// Notes vs legacy:
//   - There is NO agent button in the chat composer: `#composer-agent-button`
//     is absent from main.html and every legacy agent-button code path is
//     guarded (`composerAgentButton?…`). So we render no agent button either.
//   - Legacy used the i18n `t()` helper for the modal's placeholder/labels; it
//     always falls back to the same English/Chinese literals when no
//     translation is registered, so we inline those fallbacks directly.
//   - Legacy opened the models settings via a `reina:open-settings`
//     CustomEvent; the React renderer opens settings via
//     `bridge().openSettingsWindow("models")` (same effect).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ProviderLogo } from "~/components/ProviderLogo";
import { bridge } from "~/lib/bridge";
import { translate } from "~/lib/i18n";
import { getViewSettings } from "~/lib/viewSettings";
import { PROVIDER_BRAND_ASSETS } from "~/lib/providerBrandAssets";
import { resolveProviderBrand } from "~/lib/providerBrands";
import { getMainState } from "./sessionStore";
import { describePickerModel, parseProviderPresentation, type ProviderPresentationMeta } from "./modelPickerPresentation";
import {
  availableEffortLevels,
  MODEL_TAGS,
  PERMISSION_MODES,
  currentEffort,
  currentMode,
  currentModel,
  getAgentSettingsState,
  getModelTagKeys,
  groupBy,
  loadAgentSettings,
  modelMatchesQuery,
  modelMatchesTags,
  setEffort,
  setMode,
  setModel,
  togglePinnedModel,
  useAgentSettings,
  type KnownModel,
} from "./agentSettings";

// ── Module-level popover machinery (mirror of the legacy globals) ──────────────
//
// The legacy file kept a single shared `#composer-popover` element plus a pair
// of global outside-click / Escape listeners that are installed only while a
// popover is open. We keep the same shape, but bind to the live DOM elements
// the React component owns via refs, set at mount.

let popoverEl: HTMLDivElement | null = null;
let modeButtonEl: HTMLButtonElement | null = null;
let modelButtonEl: HTMLButtonElement | null = null;
let promptEl: HTMLTextAreaElement | null = null;
let popoverTriggerEl: HTMLButtonElement | null = null;

let popoverListenersInstalled = false;

function installPopoverListeners(): void {
  if (popoverListenersInstalled) return;
  popoverListenersInstalled = true;
  document.addEventListener("click", handleOutsideClick, true);
  document.addEventListener("keydown", handlePopoverKey, true);
}

function uninstallPopoverListeners(): void {
  if (!popoverListenersInstalled) return;
  popoverListenersInstalled = false;
  document.removeEventListener("click", handleOutsideClick, true);
  document.removeEventListener("keydown", handlePopoverKey, true);
}

function closePopover(focusTarget: "prompt" | "trigger" | "none" = "prompt"): void {
  if (!popoverEl) return;
  const wasOpen = !popoverEl.hidden;
  const trigger = popoverTriggerEl;
  popoverEl.hidden = true;
  popoverEl.classList.remove("composer-popover-modes");
  popoverEl.removeAttribute("role");
  popoverEl.removeAttribute("aria-labelledby");
  popoverEl.textContent = "";
  trigger?.setAttribute("aria-expanded", "false");
  popoverTriggerEl = null;
  uninstallPopoverListeners();
  const nextFocus = focusTarget === "trigger" ? trigger : focusTarget === "prompt" ? promptEl : null;
  if (wasOpen && nextFocus && document.activeElement !== nextFocus) {
    nextFocus.focus();
  }
}

function handleOutsideClick(event: Event): void {
  if (!popoverEl) return;
  const target = event.target as Node;
  if (popoverEl.contains(target)) return;
  if ((modeButtonEl && modeButtonEl.contains(target)) || (modelButtonEl && modelButtonEl.contains(target))) {
    return;
  }
  closePopover("none");
}

function handlePopoverKey(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    closePopover("trigger");
  }
}

function positionPopover(anchor: HTMLElement, opts?: { left?: number }): void {
  if (!popoverEl) return;
  const rect = anchor.getBoundingClientRect();
  // Toolbar buttons sit on the right of the composer. Align each popover's right
  // edge to its anchor so the menu opens leftward instead of hanging off the
  // right edge. Clamp into the viewport as a safety net. Measured after content
  // renders so offsetWidth is the real width.
  const margin = 8;
  const width = popoverEl.offsetWidth || 280;
  const desired = opts && typeof opts.left === "number" ? opts.left : rect.right - width;
  const left = Math.max(margin, Math.min(desired, window.innerWidth - width - margin));
  popoverEl.style.left = `${Math.round(left)}px`;
  popoverEl.style.bottom = `${Math.round(window.innerHeight - rect.top + 6)}px`;
}

// ── Mode + effort popover (mirror legacy openModePopover) ──────────────────────

function openModePopover(): void {
  if (!popoverEl || !modeButtonEl) return;
  const state = getAgentSettingsState();
  const effortLevels = availableEffortLevels(state.agentSettings.model);
  popoverTriggerEl = modeButtonEl;
  modeButtonEl.setAttribute("aria-expanded", "true");
  popoverEl.hidden = false;
  popoverEl.classList.add("composer-popover-modes");
  popoverEl.textContent = "";

  const header = document.createElement("div");
  header.className = "composer-popover-header";
  header.innerHTML = `<span>Modes</span><span class="composer-popover-hint"><kbd>⇧</kbd>+<kbd>tab</kbd> to switch</span>`;
  popoverEl.appendChild(header);

  for (const mode of PERMISSION_MODES) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "composer-mode-row" + (state.agentSettings.modeId === mode.id ? " active" : "");
    row.dataset.mode = mode.id;
    row.title = mode.description;
    row.innerHTML = `
      <span class="composer-mode-title"></span>
      <span class="composer-mode-check"><svg class="icon"><use href="#i-check"/></svg></span>
    `;
    row.querySelector(".composer-mode-title")!.textContent = mode.label;
    row.onclick = () => {
      setMode(mode.id);
      closePopover();
    };
    popoverEl.appendChild(row);
  }

  const effortSection = document.createElement("div");
  effortSection.className = "composer-popover-effort";
  effortSection.innerHTML = `
    <div class="composer-effort-head">
      <span class="composer-effort-label">
        <span>Effort</span>
        <span class="composer-effort-value" id="composer-effort-value"></span>
      </span>
      <span class="composer-effort-help" role="img" title="Higher = deeper thinking, slower replies." aria-label="Effort: higher means deeper thinking but slower replies.">?</span>
    </div>
    <div class="composer-effort-scale">
      <span>Faster</span>
      <span>Smarter</span>
    </div>
    <div class="composer-effort-slider-wrap">
      <span class="composer-effort-track">
        <span class="composer-effort-fill"></span>
      </span>
      <span class="composer-effort-glow"></span>
      <span class="composer-effort-knob"></span>
      <input
        type="range"
        class="composer-effort-slider"
        id="composer-effort-slider"
        min="0"
        max="${Math.max(0, effortLevels.length - 1)}"
        step="1"
      />
    </div>
  `;
  popoverEl.appendChild(effortSection);
  const sliderWrap = effortSection.querySelector(".composer-effort-slider-wrap") as HTMLElement;
  const slider = effortSection.querySelector("#composer-effort-slider") as HTMLInputElement;
  const valueLabel = effortSection.querySelector("#composer-effort-value") as HTMLElement;
  const idx = effortLevels.findIndex((effort) => effort.id === state.agentSettings.effort);
  slider.disabled = effortLevels.length === 0;
  slider.value = String(idx >= 0 ? idx : 0);
  slider.setAttribute("aria-invalid", String(idx < 0));
  slider.setAttribute("aria-label", idx < 0 ? "Choose a supported reasoning effort" : "Reasoning effort");
  const syncEffortFill = (): void => {
    const max = Math.max(1, effortLevels.length - 1);
    const value = Math.min(max, Math.max(0, Number(slider.value) || 0));
    sliderWrap.style.setProperty("--effort-fill", `${Math.round((value / max) * 100)}%`);
  };
  syncEffortFill();
  valueLabel.textContent = `${currentEffort().label}${idx < 0 ? " (unsupported)" : ""}`;
  // Live label feedback while dragging; commit (persist + live push) only on
  // release so dragging across levels doesn't fire one IPC per tick.
  slider.addEventListener("input", () => {
    const i = Math.min(effortLevels.length - 1, Math.max(0, Number(slider.value) | 0));
    if (!effortLevels[i]) return;
    slider.setAttribute("aria-invalid", "false");
    valueLabel.textContent = effortLevels[i].label;
    syncEffortFill();
    sliderWrap.classList.remove("is-bouncing");
    void sliderWrap.offsetWidth;
    sliderWrap.classList.add("is-bouncing");
  });
  slider.addEventListener("change", () => {
    const i = Math.min(effortLevels.length - 1, Math.max(0, Number(slider.value) | 0));
    if (!effortLevels[i]) return;
    syncEffortFill();
    setEffort(effortLevels[i].id);
  });

  positionPopover(modeButtonEl);
  // Defer install to next tick so the very click that opened this popover doesn't
  // immediately trigger the outside-click handler and close it.
  setTimeout(installPopoverListeners, 0);
}

// ── "More models" modal (mirror legacy openModelPickerModal) ───────────────────

let dismissModelPicker: (() => void) | null = null;

function openModelPickerModal(): void {
  dismissModelPicker?.();
  const state = getAgentSettingsState();
  const onlyDeterministic = state.knownModels.length === 1 && state.knownModels[0].id === "deterministic";
  const models = state.knownModels || [];
  const t = (key: string) => translate(getViewSettings().language, key);
  let providers: ProviderPresentationMeta[] = [];
  let selectedProvider: string | null = null;

  const modal = document.createElement("div");
  modal.id = "composer-model-modal";
  modal.className = "composer-model-modal";
  modal.innerHTML = `
    <div class="composer-model-dialog" role="dialog" aria-modal="true">
      <div class="composer-model-search">
        <div class="composer-model-search-field">
          <svg class="icon" aria-hidden="true"><use href="#i-search"/></svg>
          <input type="text" id="composer-model-search-input" autocomplete="off" spellcheck="false" placeholder="Search models..." />
        </div>
        <button class="composer-model-close" type="button" aria-label="Close">
          <svg class="icon"><use href="#i-x"/></svg>
        </button>
      </div>
      <div class="composer-model-tags" aria-label="Filter by tag"></div>
      <div class="composer-model-workspace">
        <nav class="composer-model-providers"></nav>
        <div class="composer-model-list" id="composer-model-list"></div>
      </div>
    </div>
  `;
  modal.querySelector('[role="dialog"]')!.setAttribute("aria-label", t("modelPicker.title"));
  const input = modal.querySelector("#composer-model-search-input") as HTMLInputElement;
  input.placeholder = t("modelPicker.search");
  input.setAttribute("aria-label", t("modelPicker.search"));
  modal.querySelector(".composer-model-close")!.setAttribute("aria-label", t("modelPicker.close"));
  modelButtonEl?.setAttribute("aria-expanded", "true");
  const tagsEl = modal.querySelector(".composer-model-tags") as HTMLElement;
  const list = modal.querySelector("#composer-model-list") as HTMLElement;
  const providerNav = modal.querySelector(".composer-model-providers") as HTMLElement;
  providerNav.setAttribute("aria-label", t("modelPicker.providers"));
  const selectedTags = new Set<string>();
  let focusedIndex = -1;

  const tagButtons = MODEL_TAGS.filter((tag) => tag.key !== "embedding").map((tag) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-model-tag";
    button.dataset.tag = tag.key;
    button.textContent = t(tag.labelKey);
    button.onclick = () => {
      if (selectedTags.has(tag.key)) selectedTags.delete(tag.key);
      else selectedTags.add(tag.key);
      render();
    };
    tagsEl.appendChild(button);
    return button;
  });

  function closeModelModal(focusTarget: "prompt" | "trigger" | "none" = "trigger"): void {
    modal.remove();
    document.removeEventListener("keydown", handleKeydown, true);
    dismissModelPicker = null;
    modelButtonEl?.setAttribute("aria-expanded", "false");
    if (focusTarget === "prompt") promptEl?.focus();
    else if (focusTarget === "trigger") modelButtonEl?.focus();
  }
  dismissModelPicker = () => closeModelModal("none");

  function togglePinned(modelId: string): void {
    togglePinnedModel(modelId);
    render();
    [...list.querySelectorAll<HTMLElement>(".composer-model-row")]
      .find((row) => row.dataset.modelId === modelId)?.querySelector<HTMLButtonElement>(".composer-model-pin")?.focus();
  }

  function renderTags(model: KnownModel): string {
    return getModelTagKeys(model)
      .slice(0, 3)
      .map((key) => {
        const def = MODEL_TAGS.find((tag) => tag.key === key);
        return `<span class="model-capability-chip">${def ? t(def.labelKey) : key}</span>`;
      })
      .join("");
  }

  function renderLogo(display: ReturnType<typeof describePickerModel>): HTMLElement {
    const avatar = document.createElement("span");
    avatar.className = "composer-model-avatar";
    avatar.setAttribute("aria-hidden", "true");
    const brand = display.logo.logoBrand ?? resolveProviderBrand(display.logo);
    const asset = brand ? PROVIDER_BRAND_ASSETS[brand] : undefined;
    function renderBrand() {
      avatar.replaceChildren();
      avatar.dataset.providerBrand = brand ?? "unknown";
      if (display.category === "offline") {
        avatar.innerHTML = '<svg class="icon"><use href="#i-cube"/></svg>';
      } else if (asset?.monochrome) {
        const mark = document.createElement("span");
        mark.className = "composer-model-brand-mark";
        mark.style.mask = `url("${asset.src}") center / contain no-repeat`;
        avatar.appendChild(mark);
      } else if (asset) {
        const img = document.createElement("img");
        img.src = asset.src;
        img.alt = "";
        avatar.appendChild(img);
      } else {
        avatar.textContent = Array.from(display.logo.label || display.name || "?")[0].toUpperCase();
      }
    }
    if (display.logo.logoDataUrl) {
      const img = document.createElement("img");
      img.src = display.logo.logoDataUrl;
      img.alt = "";
      img.onerror = renderBrand;
      avatar.dataset.providerBrand = "custom";
      avatar.appendChild(img);
    } else renderBrand();
    return avatar;
  }

  function renderRow(model: KnownModel, pinned = false): HTMLElement {
    const display = describePickerModel(model, providers);
    const row = document.createElement("div");
    row.className = "composer-model-row" + (getAgentSettingsState().agentSettings.modelId === model.id ? " selected" : "");
    row.dataset.modelId = model.id;
    row.innerHTML = `
      <button class="composer-model-row-main" type="button">
        <span class="composer-model-text">
          <span class="composer-model-name"></span>
          <span class="composer-model-meta"></span>
        </span>
        <span class="composer-model-caps"></span>
        <svg class="icon composer-model-selected-mark" aria-hidden="true"><use href="#i-check"/></svg>
      </button>
      <button class="composer-model-pin" type="button" aria-label="Pin model" title="Pin model">
        <svg class="icon"><use href="#i-plus"/></svg>
      </button>
    `;
    const name = display.category === "offline" ? t("modelPicker.offlineName") : display.name;
    const detail = display.category === "offline" ? t("modelPicker.offlineDetail") : display.detail;
    row.querySelector(".composer-model-name")!.textContent = name;
    const meta = row.querySelector(".composer-model-meta") as HTMLElement;
    meta.textContent = pinned ? [display.groupLabel, detail || display.groupDetail].filter(Boolean).join(" · ") : detail;
    meta.hidden = !meta.textContent;
    const main = row.querySelector(".composer-model-row-main") as HTMLButtonElement;
    main.title = [name, detail, display.groupLabel, display.groupDetail, model.provider].filter(Boolean).join("\n");
    if (getAgentSettingsState().agentSettings.modelId === model.id) main.setAttribute("aria-current", "true");
    row.querySelector(".composer-model-caps")!.innerHTML = renderTags(model);
    const pin = row.querySelector(".composer-model-pin") as HTMLButtonElement;
    const isPinned = getAgentSettingsState().modelPickerPinned.has(model.id);
    pin.classList.toggle("pinned", isPinned);
    pin.setAttribute("aria-label", t(isPinned ? "modelPicker.unpin" : "modelPicker.pin"));
    pin.title = t(isPinned ? "modelPicker.unpin" : "modelPicker.pin");
    pin.onclick = (event) => {
      event.stopPropagation();
      togglePinned(model.id);
    };
    (row.querySelector(".composer-model-row-main") as HTMLButtonElement).onclick = () => {
      setModel(model);
      closeModelModal("prompt");
    };
    return row;
  }

  function appendGroup(name: string, groupModels: KnownModel[], pinned = false): void {
    const header = document.createElement("div");
    header.className = "composer-model-group";
    const display = describePickerModel(groupModels[0], providers);
    const text = document.createElement("div");
    text.className = "composer-model-group-text";
    const title = document.createElement("span");
    title.className = "composer-model-group-name";
    title.textContent = !pinned && display.category === "offline" ? t("modelPicker.offline") : name;
    title.title = title.textContent;
    text.appendChild(title);
    if (!pinned && display.category !== "offline") {
      const meta = document.createElement("div");
      meta.className = "composer-model-group-meta";
      const kind = document.createElement("span");
      kind.className = "composer-model-group-kind";
      kind.textContent = t(display.category === "subscription" ? "modelPicker.subscriptions" : "modelPicker.api");
      meta.appendChild(kind);
      if (display.category === "api") {
        const detail = document.createElement("span");
        detail.className = "composer-model-group-detail";
        detail.textContent = display.groupDetail;
        detail.title = detail.textContent;
        meta.appendChild(detail);
      }
      text.appendChild(meta);
    }
    header.appendChild(text);
    const count = document.createElement("span");
    count.className = "composer-model-group-count";
    count.textContent = String(groupModels.length);
    header.appendChild(count);
    list.appendChild(header);
    for (const model of groupModels) list.appendChild(renderRow(model, pinned));
  }

  function appendProvider(key: string | null, groupModels: KnownModel[], count: number): void {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-model-provider";
    button.dataset.providerGroup = key ?? "";
    button.setAttribute("aria-pressed", String(selectedProvider === key));
    button.setAttribute("aria-controls", "composer-model-list");
    const display = key === null ? null : describePickerModel(groupModels[0], providers);
    if (display) button.appendChild(renderLogo(display));
    else {
      const icon = document.createElement("span");
      icon.className = "composer-model-avatar";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = '<svg class="icon"><use href="#i-cube"/></svg>';
      button.appendChild(icon);
    }
    const text = document.createElement("span");
    text.className = "composer-model-provider-text";
    const name = document.createElement("span");
    name.className = "composer-model-provider-name";
    name.textContent = !display ? t("modelPicker.allProviders") : display.category === "offline" ? t("modelPicker.offline") : display.groupLabel;
    text.appendChild(name);
    if (display && display.category !== "offline") {
      const detail = document.createElement("span");
      detail.className = "composer-model-provider-detail";
      detail.textContent = display.category === "subscription" ? t("modelPicker.subscriptions") : display.groupDetail;
      text.appendChild(detail);
    }
    button.title = [...text.children].map((child) => child.textContent).join("\n");
    button.appendChild(text);
    const total = document.createElement("span");
    total.className = "composer-model-provider-count";
    total.textContent = String(count);
    button.appendChild(total);
    button.onclick = () => {
      selectedProvider = key;
      input.value = "";
      render();
      input.focus();
    };
    providerNav.appendChild(button);
  }

  function render(): void {
    const query = input.value || "";
    const displays = new Map(models.map((model) => [model.id, describePickerModel(model, providers)]));
    const order = { subscription: 0, api: 1, offline: 2 };
    const sorted = [...models].sort((a, b) => {
      const x = displays.get(a.id)!, y = displays.get(b.id)!;
      return order[x.category] - order[y.category] || x.groupLabel.localeCompare(y.groupLabel) || x.groupDetail.localeCompare(y.groupDetail) || x.name.localeCompare(y.name);
    });
    const matches = sorted.filter((model) => {
      const display = displays.get(model.id)!;
      return modelMatchesQuery({ ...model, description: [model.description, display.name, display.detail, display.groupLabel, display.groupDetail].join(" ") }, query) && modelMatchesTags(model, selectedTags);
    });
    const providerFocus = document.activeElement instanceof HTMLElement && providerNav.contains(document.activeElement)
      ? document.activeElement.dataset.providerGroup : undefined;
    const providerScroll = providerNav.scrollTop;
    providerNav.textContent = "";
    appendProvider(null, sorted, matches.length);
    for (const [key, groupModels] of groupBy(sorted, (model) => displays.get(model.id)!.groupKey)) {
      appendProvider(key, groupModels, matches.filter((model) => displays.get(model.id)!.groupKey === key).length);
    }
    if (providerFocus !== undefined) {
      [...providerNav.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.dataset.providerGroup === providerFocus)?.focus({ preventScroll: true });
    }
    providerNav.scrollTop = providerScroll;
    const matched = selectedProvider === null ? matches : matches.filter((model) => displays.get(model.id)!.groupKey === selectedProvider);
    list.textContent = "";
    for (const button of tagButtons) {
      const active = selectedTags.has(button.dataset.tag || "");
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }

    if (onlyDeterministic || matched.length === 0) {
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "composer-model-empty";
      empty.textContent = t(onlyDeterministic ? "modelPicker.setup" : "modelPicker.noMatches");
      empty.onclick = () => {
        closeModelModal("none");
        void bridge().openSettingsWindow("models");
      };
      list.appendChild(empty);
      return;
    }

    const pinned =
      !query && selectedTags.size === 0 && selectedProvider === null
        ? matched.filter((model) => getAgentSettingsState().modelPickerPinned.has(model.id))
        : [];
    if (pinned.length > 0) appendGroup(t("modelPicker.pinned"), pinned, true);
    const pinnedIds = new Set(pinned.map((model) => model.id));
    const grouped = groupBy(
      matched.filter((model) => !pinnedIds.has(model.id)),
      (model) => displays.get(model.id)!.groupKey,
    );
    for (const groupModels of grouped.values()) appendGroup(displays.get(groupModels[0].id)!.groupLabel, groupModels);

    focusedIndex = Math.max(
      0,
      [...list.querySelectorAll<HTMLElement>(".composer-model-row")].findIndex(
        (row) => row.dataset.modelId === getAgentSettingsState().agentSettings.modelId,
      ),
    );
    syncFocusedRow();
  }

  function syncFocusedRow(): void {
    const rows = [...list.querySelectorAll<HTMLElement>(".composer-model-row")];
    rows.forEach((row, index) => row.classList.toggle("focused", index === focusedIndex));
    rows[focusedIndex]?.scrollIntoView({ block: "nearest" });
  }

  function moveFocus(delta: number): void {
    const rows = list.querySelectorAll(".composer-model-row");
    if (rows.length === 0) return;
    focusedIndex = (focusedIndex + delta + rows.length) % rows.length;
    syncFocusedRow();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModelModal();
      return;
    }
    if (event.key === "Tab") {
      const controls = [...modal.querySelectorAll<HTMLElement>('input, button:not(:disabled)')];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (providerNav.contains(event.target as Node)) {
        event.preventDefault();
        const buttons = [...providerNav.querySelectorAll<HTMLButtonElement>("button")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + direction + buttons.length) % buttons.length]?.focus();
      } else if (event.target === input || list.contains(event.target as Node)) {
        event.preventDefault();
        const focusedRow = (event.target as HTMLElement).closest<HTMLElement>(".composer-model-row");
        if (focusedRow) focusedIndex = [...list.querySelectorAll<HTMLElement>(".composer-model-row")].indexOf(focusedRow);
        moveFocus(direction);
        if (list.contains(event.target as Node)) {
          list.querySelectorAll<HTMLElement>(".composer-model-row")[focusedIndex]?.querySelector<HTMLButtonElement>(".composer-model-row-main")?.focus();
        }
      }
      return;
    }
    if (event.key === "Enter") {
      if (event.target !== input && event.target !== document.body) return;
      const rows = list.querySelectorAll<HTMLElement>(".composer-model-row");
      const row = rows[focusedIndex] || list.querySelector<HTMLElement>(".composer-model-row");
      (row?.querySelector(".composer-model-row-main") as HTMLButtonElement | null)?.click();
    }
  }

  input.addEventListener("input", () => {
    selectedProvider = null;
    render();
  });
  (modal.querySelector(".composer-model-close") as HTMLButtonElement).onclick = () => closeModelModal();
  modal.addEventListener("mousedown", (event) => {
    if (event.target === modal) closeModelModal();
  });
  document.addEventListener("keydown", handleKeydown, true);
  document.body.appendChild(modal);
  render();
  // The separate Settings window saves provider names and logo choices here.
  // Read on every opening so changes appear without restarting the main window.
  void bridge().storeGet("model-providers", "sources").then((raw) => {
    if (!modal.isConnected) return;
    providers = parseProviderPresentation(raw);
    render();
  }).catch(() => {});
  setTimeout(() => { if (modal.isConnected) input.focus(); }, 0);
}

// The model button always opens the "more models" modal (legacy openModelPopover
// returns openModelPickerModal() before its dead inline-list code).
function openModelPopover(): void {
  closePopover();
  openModelPickerModal();
}

// ── React shell ────────────────────────────────────────────────────────────────

export function ComposerPickers({
  children,
  modeAccessory,
}: {
  children?: ReactNode;
  modeAccessory?: ReactNode;
}) {
  // Live label/title/badge state — subscribe to the bits applyComposerLabels reads.
  const modeId = useAgentSettings((s) => s.agentSettings.modeId);
  const effortId = useAgentSettings((s) => s.agentSettings.effort);
  const modelId = useAgentSettings((s) => s.agentSettings.modelId);
  const modelModel = useAgentSettings((s) => s.agentSettings.model.model);
  // knownModels participates in currentModel() label resolution.
  const knownModels = useAgentSettings((s) => s.knownModels);
  const [providers, setProviders] = useState<ProviderPresentationMeta[]>([]);

  const popoverRef = useRef<HTMLDivElement>(null);
  const modeBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);

  // Provider logo edits are saved by the separate Settings window.
  useEffect(() => {
    let active = true;
    const reload = () => {
      void bridge().storeGet("model-providers", "sources").then((raw) => {
        if (active) setProviders(parseProviderPresentation(raw));
      }).catch(() => {});
    };
    reload();
    window.addEventListener("focus", reload);
    return () => {
      active = false;
      window.removeEventListener("focus", reload);
    };
  }, [modelId, knownModels]);

  // Bind the module-level popover machinery to the live DOM nodes + load the
  // persisted composer settings once on mount.
  useEffect(() => {
    popoverEl = popoverRef.current;
    modeButtonEl = modeBtnRef.current;
    modelButtonEl = modelBtnRef.current;
    promptEl = document.getElementById("prompt") as HTMLTextAreaElement | null;
    modeButtonEl?.setAttribute("aria-expanded", "false");
    void loadAgentSettings();
    // The Settings window mutates global config in a SEPARATE window —
    // models.json (`custom-models-changed`), OAuth subscription accounts
    // (`subscriptions-changed`), and agents.json (`custom-agents-changed`) —
    // each feeding the composer's known-models / agent-profiles lists. Those
    // lists are loaded once on mount, so without re-loading here a freshly
    // configured model / connected subscription / new agent isn't selectable
    // until an app restart. Re-resolve on any of them. loadAgentSettings keeps
    // the current selection when it still exists; only the lists (and edited
    // baseUrl/apiKey) refresh.
    const reloadOffs = [
      "custom-models-changed",
      "subscriptions-changed",
      "custom-agents-changed",
      "agent-settings-changed",
    ].map((evt) => bridge().events.on(evt, () => {
      void (async () => {
        const sessionId = getMainState().sessionId;
        if (evt === "custom-models-changed" && sessionId) {
          await bridge().invoke("refresh_session_settings", { sessionId }).catch(() => undefined);
        }
        await loadAgentSettings();
      })();
    }));
    return () => {
      for (const off of reloadOffs) off?.();
      closePopover("none");
      dismissModelPicker?.();
      popoverEl = null;
      modeButtonEl = null;
      modelButtonEl = null;
      promptEl = null;
    };
  }, []);

  // Mirror applyComposerLabels' side effect: reflect the active permission mode
  // onto <body data-mode="…"> so CSS can tint the composer halo by risk tier.
  useEffect(() => {
    document.body.dataset.mode = modeId || "ask";
  }, [modeId]);

  // ── Derived labels/titles (mirror applyComposerLabels) ────────────────────
  const mode = currentMode();
  const effort = currentEffort();
  const model = currentModel();
  void modelId; // selector dependency — currentModel() resolves from store

  const modeLabel = mode.short ?? mode.label;
  const modeTitle = `${mode.label} · Effort: ${effort.label} · Shift+Tab to cycle`;
  void effortId; // selector dependency for the title above

  const modelLabel = (model?.subscription ? model.model : model?.label) || modelModel || "Model";
  const modelDisplay = model ? describePickerModel(model, providers) : undefined;

  // ── Button click handlers (mirror bindComposerPickers) ────────────────────
  const onModeClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (popoverEl && !popoverEl.hidden) {
      closePopover("trigger");
      return;
    }
    openModePopover();
  };
  const onModelClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    closePopover("none");
    openModelPopover();
  };
  return (
    <>
      {/* Permission-mode picker (mode + effort popover). Rendered as a direct
          child of .composer-actions so it sits on the LEFT next to the attach
          button; the remaining pickers stay right-aligned in .composer-selects. */}
      <button
        className="select-button"
        id="composer-mode-button"
        type="button"
        title={modeTitle}
        aria-haspopup="listbox"
        aria-controls="composer-popover"
        ref={modeBtnRef}
        onClick={onModeClick}
      >
        <span data-role="label">{modeLabel}</span>
        <svg className="icon caret" viewBox="0 0 24 24" aria-hidden focusable={false}>
          <use href="#i-chevron-down" />
        </svg>
      </button>

      {modeAccessory}

      {/* Model picker and the usage ring passed as children stay grouped on the
          right via .composer-selects' margin-left:auto. */}
      <div className="composer-selects">
        {/* Model picker (opens the "more models" modal) */}
        <button
          className="select-button"
          id="composer-model-button"
          type="button"
          title="Model"
          aria-haspopup="dialog"
          aria-controls="composer-model-modal"
          ref={modelBtnRef}
          onClick={onModelClick}
        >
          {modelDisplay && modelDisplay.category !== "offline" ? (
            <ProviderLogo {...modelDisplay.logo} className="composer-provider-logo" />
          ) : (
            <svg className="icon select-icon" viewBox="0 0 24 24" aria-hidden focusable={false}>
              <use href="#i-cube" />
            </svg>
          )}
          <span data-role="label">{modelLabel}</span>
          <svg className="icon caret" viewBox="0 0 24 24" aria-hidden focusable={false}>
            <use href="#i-chevron-down" />
          </svg>
        </button>

        {/* Usage ring (passed from Composer) — stays on the right with the model. */}
        {children}
      </div>

      {/* Shared composer popover for permission mode + effort. Content is built
          imperatively to stay byte-identical to legacy. */}
      <div className="composer-popover" id="composer-popover" hidden ref={popoverRef} />
    </>
  );
}
