/* ============================================================
   clock.ts — live clock in the top bar.
   ============================================================ */

import { byId } from "./dom.js";

export function initClock(): void {
  const el = byId("clock");
  if (!el) return;

  const tick = (): void => {
    el.textContent = new Date().toLocaleTimeString("es-ES", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  tick();
  window.setInterval(tick, 1000);
}
