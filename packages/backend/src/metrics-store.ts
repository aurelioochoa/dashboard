/* ============================================================
   metrics-store.ts — latest snapshot + bounded history per
   device.

   History exists to draw sparklines, not to be a time-series
   database: a fixed-size ring buffer of narrow samples, held in
   memory and discarded on restart.
   ============================================================ */

import { toSample, type DeviceMetrics, type MetricSample } from "@homelab/shared";
import { env } from "./env.js";

const latest = new Map<string, DeviceMetrics>();
const history = new Map<string, MetricSample[]>();

export function recordMetrics(metrics: DeviceMetrics): void {
  latest.set(metrics.device, metrics);

  // Only successful ticks belong in the sparkline; a failed poll would
  // otherwise draw a misleading drop to zero.
  if (!metrics.ok) return;

  let buffer = history.get(metrics.device);
  if (!buffer) {
    buffer = [];
    history.set(metrics.device, buffer);
  }
  buffer.push(toSample(metrics));
  if (buffer.length > env.historySize) {
    buffer.splice(0, buffer.length - env.historySize);
  }
}

export function latestMetrics(): DeviceMetrics[] {
  return [...latest.values()];
}

export function metricsFor(device: string): DeviceMetrics | null {
  return latest.get(device) ?? null;
}

/** Samples for one device, optionally limited to the last `windowSec`. */
export function historyFor(device: string, windowSec?: number): MetricSample[] {
  const buffer = history.get(device) ?? [];
  if (!windowSec || windowSec <= 0) return [...buffer];
  const cutoff = Date.now() - windowSec * 1000;
  return buffer.filter((s) => s.t >= cutoff);
}

export function allHistory(windowSec?: number): Record<string, MetricSample[]> {
  const out: Record<string, MetricSample[]> = {};
  for (const device of history.keys()) out[device] = historyFor(device, windowSec);
  return out;
}

/** Drop state for devices that no longer exist in config.yaml. */
export function pruneTo(deviceNames: Iterable<string>): void {
  const keep = new Set(deviceNames);
  for (const name of [...latest.keys()]) if (!keep.has(name)) latest.delete(name);
  for (const name of [...history.keys()]) if (!keep.has(name)) history.delete(name);
}

export function resetStore(): void {
  latest.clear();
  history.clear();
}
