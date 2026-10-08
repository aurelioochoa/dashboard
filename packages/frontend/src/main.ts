/* ============================================================
   main.ts — application entry point.

   Boots the shell, loads config from the backend, renders, then
   opens the SSE stream that keeps everything live.
   ============================================================ */

import "./styles/index.css";

import type { Config } from "@homelab/shared";
import { fetchConfig, fetchHealth, fetchMetrics, openStream, type StreamState } from "./api.js";
import { initClock } from "./clock.js";
import { initConfigEditor, ensureConfigEditor } from "./config-editor.js";
import { byId, esc } from "./dom.js";
import { initFilters } from "./filters.js";
import { ensureIconPicker, onIconsChanged } from "./icon-picker.js";
import { applyHealth, decorateServicePills, repaintHealth } from "./health.js";
import { applyMetrics, primeHistory, startStaleWatcher } from "./metrics.js";
import { initNav } from "./nav.js";
import { initPalette, refreshPaletteIndex } from "./palette.js";
import { focusDevice, render } from "./render.js";
import { currentRoute, initRouter, onRouteChange } from "./router.js";
import { initServices, refreshServicesHealth, resetServiceFilters, showServices } from "./services.js";
import { initSidebarCopy } from "./sidebar.js";
import { initShortcuts } from "./shortcuts.js";
import { showToast } from "./toast.js";
import { applyTopology, initTopology } from "./topology.js";

let config: Config | null = null;

async function boot(): Promise<void> {
  initRouter();
  initClock();
  initNav();
  initSidebarCopy();
  initConfigEditor();
  initShortcuts(() => void reload(true));

  onRouteChange((route) => {
    if (route.device) focusDevice(route.device);
    if (route.tab === "config") openConfigTab();
    if (route.tab === "services") showServices();
  });

  try {
    await reload(false);
  } catch (err) {
    showFatal(err instanceof Error ? err.message : String(err));
    return;
  }

  startStaleWatcher();
  connectStream();

  const route = currentRoute();
  if (route.device) focusDevice(route.device);
  if (route.tab === "config") openConfigTab();
  if (route.tab === "services") showServices();
}

/** The Config tab boots two lazy pieces: the YAML editor and the
 *  preset-icon gallery beside it. */
function openConfigTab(): void {
  ensureConfigEditor();
  ensureIconPicker();
}

/** Load config and re-render every view that derives from it. */
async function reload(notify: boolean): Promise<void> {
  config = await fetchConfig();

  render(config);
  initFilters(config);
  initPalette(config);
  refreshPaletteIndex(config);
  resetServiceFilters();
  initServices(config);
  initTopology(config);

  document.title = config.title;
  const titleEl = byId("title");
  if (titleEl && currentRoute().tab === "dashboard") titleEl.textContent = "Dashboard";

  // Paint whatever the backend already knows so the first frame isn't
  // empty while we wait for the next poll tick.
  const names = config.devices.map((d) => d.name);
  await primeHistory(names);

  const [metrics, health] = await Promise.all([
    fetchMetrics().catch(() => []),
    fetchHealth().catch(() => []),
  ]);
  for (const m of metrics) applyMetrics(m);
  if (health.length) {
    applyHealth(health);
    decorateServicePills();
  }

  if (notify) showToast("Datos recargados", "success");
}

function connectStream(): void {
  openStream({
    state: setStreamState,
    metrics: (m) => applyMetrics(m),
    health: (batch) => {
      applyHealth(batch);
      decorateServicePills();
      refreshServicesHealth();
    },
    topology: (snapshot) => applyTopology(snapshot),
    config: () => {
      // config.yaml changed on disk or was saved from the editor.
      void reload(false).then(() => {
        repaintHealth();
        decorateServicePills();
        showToast("Configuración actualizada", "info");
      });
    },
    // Someone uploaded or deleted a custom icon — refresh any open gallery.
    icons: () => onIconsChanged(),
  });
}

function setStreamState(state: StreamState): void {
  const el = byId("stream-status");
  if (!el) return;
  el.className = `conn-pill state-${state === "connected" ? "connected" : state === "error" ? "error" : "connecting"}`;
  el.title =
    state === "connected"
      ? "Conectado al backend — datos en vivo"
      : state === "error"
        ? "Sin conexión con el backend"
        : "Conectando…";
}

function showFatal(message: string): void {
  const container = byId("devices");
  if (!container) return;
  container.innerHTML =
    '<div class="placeholder-panel" style="grid-column:1/-1">' +
    '<div class="placeholder-icon">⚠️</div>' +
    `<h2>Sin conexión con el backend</h2><p>${esc(message)}</p>` +
    "<p>Verificá que el servidor esté corriendo.</p>" +
    "</div>";
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot());
} else {
  void boot();
}
