/* ============================================================
   render.ts — top-level dashboard rendering.
   Owns the deviceName → card-element registry that metrics.ts
   and health.ts use to update live regions in place.
   ============================================================ */

import type { Config, Device } from "@homelab/shared";
import { byId, copyText, qsa } from "./dom.js";
import { createCard } from "./cards.js";
import { openIconDialog } from "./icon-picker.js";
import { renderNetwork, renderStats } from "./sidebar.js";
import { navigate } from "./router.js";

const DEVICE_ELEMENTS = new Map<string, HTMLElement>();
let gridBound = false;

export function getDeviceElement(name: string): HTMLElement | null {
  return DEVICE_ELEMENTS.get(name) ?? null;
}

export function allDeviceElements(): ReadonlyMap<string, HTMLElement> {
  return DEVICE_ELEMENTS;
}

export function render(config: Config): void {
  renderNetwork(config);
  renderStats(config.devices ?? []);

  const container = byId("devices");
  if (!container) return;

  container.innerHTML = "";
  DEVICE_ELEMENTS.clear();

  const devices: Device[] = config.devices ?? [];
  if (!devices.length) {
    container.innerHTML =
      '<div class="placeholder-panel" style="grid-column:1/-1"><p>No hay dispositivos configurados.</p></div>';
    return;
  }

  for (const device of devices) {
    const card = createCard(device);
    DEVICE_ELEMENTS.set(device.name, card);
    container.appendChild(card);
  }

  // Bind exactly once — render() runs again on every config reload, and
  // re-binding here would multiply the handler on each pass.
  if (!gridBound) {
    container.addEventListener("click", onCardClick);
    container.addEventListener("keydown", onCardKeydown);
    gridBound = true;
  }
}

function onCardClick(e: Event): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  const toggle = target.closest<HTMLElement>("[data-specs-toggle]");
  if (toggle) {
    toggleSpecs(toggle);
    return;
  }

  // The avatar is a button: it opens the icon gallery for its device.
  const avatar = target.closest<HTMLElement>("[data-icon-picker]");
  if (avatar) {
    openIconDialog(avatar.dataset["iconPicker"] ?? "");
    return;
  }

  // Let real links through untouched.
  if (target.closest("a")) return;

  const copyEl = target.closest<HTMLElement>("[data-copy]");
  if (copyEl) {
    void copyText(copyEl.dataset.copy ?? "");
  }
}

function toggleSpecs(toggle: HTMLElement): void {
  const card = toggle.closest<HTMLElement>(".device-card");
  if (!card) return;
  const open = card.classList.toggle("specs-open");
  toggle.setAttribute("aria-expanded", String(open));
}

/** Keyboard support: arrows move between cards, Enter/Space activates
 *  the focused element, `s` toggles the focused card's specs. */
function onCardKeydown(e: Event): void {
  const ev = e as KeyboardEvent;
  const target = ev.target as HTMLElement | null;
  if (!target) return;

  if (ev.key === "Enter" || ev.key === " ") {
    const copyEl = target.closest<HTMLElement>("[data-copy][role='button']");
    if (copyEl) {
      ev.preventDefault();
      void copyText(copyEl.dataset.copy ?? "");
      return;
    }
  }

  const card = target.closest<HTMLElement>(".device-card");
  if (!card) return;

  if (ev.key === "s" && !ev.ctrlKey && !ev.metaKey) {
    const toggle = card.querySelector<HTMLElement>("[data-specs-toggle]");
    if (toggle) {
      ev.preventDefault();
      toggleSpecs(toggle);
    }
    return;
  }

  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key)) return;
  if (target !== card) return; // don't hijack arrows inside the specs table

  const cards = qsa<HTMLElement>(".device-card:not([hidden])");
  const index = cards.indexOf(card);
  if (index < 0) return;

  // The bento grid is 2 columns above 960px and 1 below; read the real
  // column count so Up/Down move a visual row, not a fixed stride.
  const columns = gridColumnCount();
  const delta =
    ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : ev.key === "ArrowDown" ? columns : -columns;

  const next = cards[Math.max(0, Math.min(cards.length - 1, index + delta))];
  if (next && next !== card) {
    ev.preventDefault();
    next.focus();
    navigate({ tab: "dashboard", device: next.dataset.device }, true);
  }
}

function gridColumnCount(): number {
  const grid = byId("devices");
  if (!grid) return 1;
  const template = getComputedStyle(grid).gridTemplateColumns;
  return Math.max(1, template.split(" ").filter(Boolean).length);
}

/** Scroll a device card into view and focus it (used by the router,
 *  command palette and topology view). */
export function focusDevice(name: string): void {
  const card = getDeviceElement(name);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.focus({ preventScroll: true });
  card.classList.add("card-flash");
  window.setTimeout(() => card.classList.remove("card-flash"), 1200);
}
