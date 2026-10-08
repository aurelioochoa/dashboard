/* ============================================================
   events.ts — in-process pub/sub feeding the SSE stream.

   Single-writer, many-reader: collectors and watchers publish,
   every connected browser gets the same payloads.
   ============================================================ */

import type { DeviceMetrics } from "@homelab/shared";
import type { HealthResult } from "@homelab/shared";
import type { TopologySnapshot } from "@homelab/shared";

export type DashboardEvent =
  | { type: "metrics"; data: DeviceMetrics }
  | { type: "health"; data: HealthResult[] }
  | { type: "topology"; data: TopologySnapshot }
  | { type: "config"; data: { reason: "changed" | "saved" } }
  | { type: "icons"; data: { reason: "saved" | "deleted" } };

type Subscriber = (event: DashboardEvent) => void;

const subscribers = new Set<Subscriber>();

export function publish(event: DashboardEvent): void {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {
      // A broken client must never take down a collector tick.
    }
  }
}

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function subscriberCount(): number {
  return subscribers.size;
}
