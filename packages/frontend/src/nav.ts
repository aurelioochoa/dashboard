/* ============================================================
   nav.ts — sidebar tab navigation, driven by the hash router so
   every tab is deep-linkable and survives a reload.
   ============================================================ */

import { byId, qsa } from "./dom.js";
import { currentRoute, navigate, onRouteChange, type TabId } from "./router.js";

const NAV_TITLES: Record<TabId, string> = {
  dashboard: "Dashboard",
  topology: "Topology",
  services: "Servicios",
  config: "Config",
};

export function initNav(): void {
  const buttons = qsa<HTMLButtonElement>(".nav-item");

  for (const btn of buttons) {
    const tab = btn.dataset.tab as TabId | undefined;
    if (!tab) continue;
    btn.setAttribute("role", "tab");
    btn.addEventListener("click", () => navigate({ tab }));
  }

  onRouteChange((route) => applyRoute(route.tab, buttons));
  applyRoute(currentRoute().tab, buttons);
}

function applyRoute(tab: TabId, buttons: HTMLButtonElement[]): void {
  for (const btn of buttons) {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
    btn.tabIndex = isActive ? 0 : -1;
  }

  for (const view of qsa<HTMLElement>(".tab-view")) {
    const isActive = view.id === `${tab}-view`;
    view.hidden = !isActive;
    view.classList.toggle("active", isActive);
  }

  const titleEl = byId("title");
  if (titleEl) titleEl.textContent = NAV_TITLES[tab];
  document.title = `${NAV_TITLES[tab]} · Homelab`;
}
