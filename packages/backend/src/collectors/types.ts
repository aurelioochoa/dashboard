/* ============================================================
   Collector contract.

   A collector turns one device into one DeviceMetrics sample.
   Implementations must resolve rather than reject on a failed
   poll — a down host is data ("ok: false"), not an exception —
   so a single unreachable box never stalls the scheduler.
   ============================================================ */

import type { Device, DeviceMetrics } from "@homelab/shared";

export interface MetricsCollector {
  readonly kind: "ssh" | "openwrt" | "exporter";
  collect(device: Device): Promise<DeviceMetrics>;
  /** Release any persistent connection held for this device. */
  release(deviceName: string): void;
  /** Tear everything down (shutdown / config reload). */
  dispose(): void;
}

export function failed(
  device: string,
  source: DeviceMetrics["source"],
  err: unknown,
): DeviceMetrics {
  return {
    device,
    timestamp: Date.now(),
    source,
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  };
}
