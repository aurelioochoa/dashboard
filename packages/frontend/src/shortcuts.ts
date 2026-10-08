/* ============================================================
   shortcuts.ts — global keyboard handling.
   ============================================================ */

import { byId } from "./dom.js";
import { clearFilters } from "./filters.js";
import { isPaletteOpen, openPalette } from "./palette.js";
import { navigate, TAB_IDS } from "./router.js";

/** True when the user is typing somewhere a bare letter shouldn't be a shortcut. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

export function initShortcuts(onReload: () => void): void {
  document.addEventListener("keydown", (e) => {
    // Ctrl/Cmd+K works everywhere, including inside inputs.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openPalette();
      return;
    }

    if (isPaletteOpen() || isTyping(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case "/":
        e.preventDefault();
        openPalette();
        break;

      case "?":
        e.preventDefault();
        byId<HTMLDialogElement>("shortcuts")?.showModal();
        break;

      case "r":
        e.preventDefault();
        onReload();
        break;

      case "Escape":
        // Esc clears filters when nothing modal is open.
        if (clearFilters()) e.preventDefault();
        break;

      case "1":
      case "2":
      case "3":
      case "4": {
        const tab = TAB_IDS[Number(e.key) - 1];
        if (tab) {
          e.preventDefault();
          navigate({ tab });
        }
        break;
      }
    }
  });
}
