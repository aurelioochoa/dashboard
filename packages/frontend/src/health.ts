/* ============================================================
   health.ts — paint probe results onto cards.

   Elements opt in by carrying data-health-id matching the id the
   backend generates (see healthId in @homelab/shared), so lookup
   is a single querySelector rather than a per-card search.
   ============================================================ */

import { formatUptime, type HealthResult } from "@homelab/shared";
import { qs, qsa } from "./dom.js";

const results = new Map<string, HealthResult>();

export function applyHealth(batch: HealthResult[]): void {
  for (const result of batch) results.set(result.id, result);
  for (const result of batch) paint(result);
}

export function latestHealth(): ReadonlyMap<string, HealthResult> {
  return results;
}

export function healthForDevice(device: string): HealthResult[] {
  return [...results.values()].filter((r) => r.device === device);
}

/** Re-apply everything — needed after a re-render replaces the cards. */
export function repaintHealth(): void {
  for (const result of results.values()) paint(result);
}

function paint(result: HealthResult): void {
  for (const el of qsa<HTMLElement>(`[data-health-id="${cssAttr(result.id)}"]`)) {
    el.classList.remove("probe-up", "probe-down");
    el.classList.add(result.state === "up" ? "probe-up" : "probe-down");
    el.title = describe(result);
  }
}

export function describe(result: HealthResult): string {
  const parts: string[] = [];
  parts.push(result.state === "up" ? "Reachable" : "Unreachable");
  if (result.status !== undefined) parts.push(`HTTP ${result.status}`);
  if (result.responseMs !== undefined) parts.push(`${result.responseMs} ms`);
  if (result.error) parts.push(result.error);
  const age = Math.max(0, Math.round((Date.now() - result.checkedAt) / 1000));
  parts.push(`checked ${age < 60 ? `${age}s` : formatUptime(age)} ago`);
  return `${result.label} — ${parts.join(" · ")}`;
}

/** Roll per-target probes up into one dot per service pill. */
export function decorateServicePills(): void {
  for (const pill of qsa<HTMLElement>(".svc-pill")) {
    const card = pill.closest<HTMLElement>(".device-card");
    const device = card?.dataset["device"];
    const service = pill.dataset["service"];
    if (!device || !service) continue;

    const match = [...results.values()].find(
      (r) => r.device === device && r.label.toLowerCase() === service.toLowerCase(),
    );
    if (!match) continue;

    const dot = qs<HTMLElement>(".svc-dot", pill);
    if (dot) {
      dot.classList.remove("up", "down");
      dot.classList.add(match.state === "up" ? "up" : "down");
    }
    pill.title = describe(match);
  }
}

function cssAttr(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
