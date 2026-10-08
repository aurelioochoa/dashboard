/* ============================================================
   metrics.ts — paint live metrics onto the device cards.

   Updates existing nodes in place rather than re-rendering the
   card: re-rendering would destroy focus, the specs toggle state
   and the CSS width transition that makes the bars animate.
   ============================================================ */

import {
  formatBytes, formatRate, formatUptime, healthColor,
  type DeviceMetrics, type MetricSample,
} from "@homelab/shared";
import { esc, qs } from "./dom.js";
import { getDeviceElement } from "./render.js";
import { drawSparkline } from "./sparkline.js";
import { fetchHistory } from "./api.js";

/** A tick older than this means the collector has stopped reporting. */
const STALE_AFTER_MS = 90_000;
const SPARK_POINTS = 40;

const history = new Map<string, MetricSample[]>();
let staleTimer: number | null = null;

export function applyMetrics(metrics: DeviceMetrics): void {
  const card = getDeviceElement(metrics.device);
  if (!card) return;

  const row = qs<HTMLElement>("[data-health-row]", card);
  const dot = qs<HTMLElement>("[data-state-dot]", card);
  const type = card.dataset.type ?? "server-x86";

  setStateDot(dot, metrics);
  if (!row) return;

  row.dataset.at = String(metrics.timestamp);

  if (!metrics.ok) {
    row.classList.remove("is-live");
    row.classList.add("is-stale");
    setError(row, metrics.error);
    return;
  }

  row.classList.add("is-live");
  row.classList.remove("is-stale");
  setError(row, undefined);

  pushSample(metrics);
  const samples = history.get(metrics.device) ?? [];

  updateBar(row, "cpu", "CPU", metrics.cpuPct, type, {
    detail: metrics.loadavg ? `load ${metrics.loadavg[0].toFixed(2)}` : undefined,
    series: samples.map((s) => s.cpu),
  });

  updateBar(row, "mem", "RAM", metrics.memPct, type, {
    detail:
      metrics.memUsedBytes !== undefined && metrics.memTotalBytes !== undefined
        ? `${formatBytes(metrics.memUsedBytes)} / ${formatBytes(metrics.memTotalBytes)}`
        : undefined,
    series: samples.map((s) => s.mem),
  });

  updateExtras(row, metrics, type);
  updateFoot(row, metrics);
}

function setStateDot(dot: HTMLElement | null, metrics: DeviceMetrics): void {
  if (!dot) return;
  dot.classList.remove("ok", "warn", "err", "idle");
  dot.classList.add(metrics.ok ? "ok" : "err");
  dot.title = metrics.ok
    ? `Metrics via ${metrics.source} — updated ${new Date(metrics.timestamp).toLocaleTimeString()}`
    : `Collector error: ${metrics.error ?? "unknown"}`;
}

function setError(row: HTMLElement, message: string | undefined): void {
  let el = qs<HTMLElement>(".health-error", row);
  if (!message) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "health-error";
    row.appendChild(el);
  }
  el.textContent = message;
  el.title = message;
}

interface BarOptions {
  detail?: string;
  series?: Array<number | undefined>;
  /** Upper bound for the bar and sparkline. Defaults to 100 (a percentage). */
  max?: number;
  unit?: string;
}

function updateBar(
  row: HTMLElement,
  key: string,
  label: string,
  value: number | undefined,
  type: string,
  options: BarOptions = {},
): void {
  const item = qs<HTMLElement>(`[data-metric="${attr(key)}"]`, row);
  if (!item) return;

  const labelEl = qs<HTMLElement>(".health-label", item);
  const fill = qs<HTMLElement>(".health-fill", item);
  const max = options.max ?? 100;

  if (value === undefined) {
    if (labelEl) labelEl.innerHTML = `${esc(label)} <span class="health-dim">—</span>`;
    if (fill) {
      fill.style.width = "0%";
      fill.style.background = "var(--muted)";
    }
    return;
  }

  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const shown = options.unit ? `${value}${options.unit}` : `${value}%`;

  if (labelEl) {
    labelEl.innerHTML = `${esc(label)} <span class="health-val">${esc(shown)}</span>`;
    if (options.detail) labelEl.title = options.detail;
  }
  if (fill) {
    fill.style.width = `${pct}%`;
    fill.style.background = healthColor(pct, type);
  }

  const spark = qs<SVGElement>("[data-spark]", item);
  if (spark && options.series) {
    const series = options.series.filter((v): v is number => v !== undefined).slice(-SPARK_POINTS);
    // Temperatures move in fractions of a degree; percentages in whole
    // points. Different floors keep both readable without exaggerating noise.
    drawSparkline(spark, series, {
      color: healthColor(pct, type),
      minSpan: options.unit === "°" ? 3 : 5,
    });
  }
}

/** Disk and temperature bars, created on demand — how many a host has
 *  isn't known until the first successful poll. */
function updateExtras(row: HTMLElement, metrics: DeviceMetrics, type: string): void {
  const host = qs<HTMLElement>("[data-metric-extras]", row);
  if (!host) return;

  const wanted: Array<{ key: string; label: string; value: number; detail: string; max?: number; unit?: string }> = [];

  // Only the largest couple of filesystems: a card is not a df readout.
  for (const disk of (metrics.disks ?? []).slice(0, 2)) {
    wanted.push({
      key: `disk:${disk.mount}`,
      label: diskLabel(disk.mount),
      value: disk.usedPct,
      detail: `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)} on ${disk.mount}`,
    });
  }

  const hottest = metrics.temps?.[0];
  if (hottest) {
    wanted.push({
      key: "temp",
      label: "TEMP",
      value: hottest.celsius,
      detail: (metrics.temps ?? []).map((t) => `${t.label}: ${t.celsius}°C`).join("\n"),
      // 90 °C as full scale keeps a 55 °C SBC from looking alarming.
      max: 90,
      unit: "°",
    });
  }

  if (metrics.swapPct !== undefined && metrics.swapPct > 0) {
    wanted.push({
      key: "swap",
      label: "SWAP",
      value: metrics.swapPct,
      detail: `${formatBytes(metrics.swapUsedBytes ?? 0)} / ${formatBytes(metrics.swapTotalBytes ?? 0)}`,
    });
  }

  const keys = new Set(wanted.map((w) => w.key));
  for (const existing of Array.from(host.children)) {
    const key = (existing as HTMLElement).dataset["metric"];
    if (!key || !keys.has(key)) existing.remove();
  }

  for (const spec of wanted) {
    let item = qs<HTMLElement>(`[data-metric="${attr(spec.key)}"]`, host);
    if (!item) {
      item = document.createElement("div");
      item.className = "health-item";
      item.dataset["metric"] = spec.key;
      item.innerHTML =
        '<div class="health-label"></div>' +
        '<div class="health-track"><div class="health-fill" style="width:0%"></div></div>' +
        '<svg class="spark" data-spark viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"></svg>';
      host.appendChild(item);
    }
    updateBar(host, spec.key, spec.label, spec.value, type, {
      detail: spec.detail,
      max: spec.max,
      unit: spec.unit,
      series: spec.key === "temp" ? (history.get(metrics.device) ?? []).map((s) => s.temp) : undefined,
    });
  }
}

function updateFoot(row: HTMLElement, metrics: DeviceMetrics): void {
  const uptimeEl = qs<HTMLElement>("[data-uptime]", row);
  if (uptimeEl) {
    uptimeEl.textContent = metrics.uptimeSec !== undefined ? `up ${formatUptime(metrics.uptimeSec)}` : "";
  }

  const netEl = qs<HTMLElement>("[data-net]", row);
  const primary = metrics.net?.[0];
  if (netEl) {
    netEl.textContent = primary
      ? `${primary.iface} ↓${formatRate(primary.rxBytesPerSec)} ↑${formatRate(primary.txBytesPerSec)}`
      : "";
  }
}

/** Keep disk labels short enough for a card column: "/" is just DISK,
 *  and a deep mount like /srv/backup/snap shows only its last segment. */
function diskLabel(mount: string): string {
  if (mount === "/") return "DISK";
  const last = mount.split("/").filter(Boolean).pop() ?? mount;
  return `DISK ${last.length > 8 ? `${last.slice(0, 7)}…` : last}`;
}

function pushSample(metrics: DeviceMetrics): void {
  let series = history.get(metrics.device);
  if (!series) {
    series = [];
    history.set(metrics.device, series);
  }
  series.push({
    t: metrics.timestamp,
    cpu: metrics.cpuPct,
    mem: metrics.memPct,
    temp: metrics.temps?.[0]?.celsius,
  });
  if (series.length > SPARK_POINTS * 2) series.splice(0, series.length - SPARK_POINTS * 2);
}

/** Seed sparklines from the backend's ring buffer so a fresh tab shows a
 *  trend immediately instead of drawing nothing for the first minute. */
export async function primeHistory(deviceNames: string[]): Promise<void> {
  await Promise.all(
    deviceNames.map(async (name) => {
      try {
        const { samples } = await fetchHistory(name, 3600);
        if (samples.length) history.set(name, samples.slice(-SPARK_POINTS * 2));
      } catch {
        // No history yet is normal right after a backend restart.
      }
    }),
  );
}

/** Dim the LIVE pill on cards whose collector has gone quiet. */
export function startStaleWatcher(): void {
  if (staleTimer !== null) return;
  staleTimer = window.setInterval(() => {
    const now = Date.now();
    for (const row of document.querySelectorAll<HTMLElement>("[data-health-row]")) {
      const at = Number(row.dataset["at"] ?? 0);
      if (!at) continue;
      const stale = now - at > STALE_AFTER_MS;
      row.classList.toggle("is-stale", stale);
      row.classList.toggle("is-live", !stale);
    }
  }, 15_000);
}

export function resetMetricsState(): void {
  history.clear();
}

/** Escape a value for use inside a *quoted* attribute selector.
 *  CSS.escape is wrong here — it escapes for unquoted identifiers, so
 *  keys like "disk:/home" come back mangled. Inside quotes only the
 *  quote character and backslash need escaping. */
function attr(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
