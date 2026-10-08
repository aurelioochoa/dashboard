/* ============================================================
   collectors/index.ts — registry + poll scheduler.

   Each device gets its own timer at its own interval. Ticks are
   self-scheduling (setTimeout after completion, not setInterval)
   so a slow host can never stack up overlapping polls.
   ============================================================ */

import { resolveMetricsSource, type Config, type Device, type DeviceMetrics } from "@homelab/shared";
import type { FastifyBaseLogger } from "fastify";
import { publish } from "../events.js";
import { pruneTo, recordMetrics } from "../metrics-store.js";
import { ExporterCollector } from "./exporter.js";
import { OpenWrtCollector } from "./openwrt.js";
import { SshCollector } from "./ssh.js";
import type { MetricsCollector } from "./types.js";

export class CollectorRegistry {
  private readonly collectors: Record<string, MetricsCollector> = {
    ssh: new SshCollector(),
    openwrt: new OpenWrtCollector(),
    exporter: new ExporterCollector(),
  };

  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();
  private stopped = false;

  constructor(private readonly log: FastifyBaseLogger) {}

  /** (Re)start polling for exactly the devices in this config. */
  start(config: Config): void {
    this.stopTimers();
    this.stopped = false;

    const active: string[] = [];
    for (const device of config.devices) {
      const source = resolveMetricsSource(device);
      if (source.type === "none") continue;

      const collector = this.collectors[source.type];
      if (!collector) {
        this.log.warn({ device: device.name, type: source.type }, "no collector for metrics type");
        continue;
      }

      active.push(device.name);
      const intervalMs = Math.max(1000, source.interval * 1000);
      this.schedule(device, collector, intervalMs, 0);
    }

    // Forget devices that were removed from config.yaml.
    pruneTo(active);
    for (const collector of Object.values(this.collectors)) {
      for (const name of this.timers.keys()) {
        if (!active.includes(name)) collector.release(name);
      }
    }

    this.log.info({ devices: active.length }, "metrics collection started");
  }

  /** Poll one device now, outside its schedule. */
  async pollOnce(device: Device): Promise<DeviceMetrics | null> {
    const source = resolveMetricsSource(device);
    if (source.type === "none") return null;
    const collector = this.collectors[source.type];
    if (!collector) return null;
    return collector.collect(device);
  }

  private schedule(
    device: Device,
    collector: MetricsCollector,
    intervalMs: number,
    delayMs: number,
  ): void {
    const timer = setTimeout(() => void this.tick(device, collector, intervalMs), delayMs);
    // A pending poll must not keep the process alive during shutdown.
    timer.unref?.();
    this.timers.set(device.name, timer);
  }

  private async tick(device: Device, collector: MetricsCollector, intervalMs: number): Promise<void> {
    if (this.stopped) return;

    // Guard against a poll that outlives its own interval.
    if (this.running.has(device.name)) {
      this.schedule(device, collector, intervalMs, intervalMs);
      return;
    }

    this.running.add(device.name);
    try {
      const metrics = await collector.collect(device);
      if (this.stopped) return;
      recordMetrics(metrics);
      publish({ type: "metrics", data: metrics });
      if (!metrics.ok) {
        this.log.debug({ device: device.name, error: metrics.error }, "metrics poll failed");
      }
    } catch (err) {
      // collect() is contracted not to throw, but a bug there must not
      // silently kill this device's timer.
      this.log.error({ err, device: device.name }, "collector threw");
    } finally {
      this.running.delete(device.name);
      if (!this.stopped) this.schedule(device, collector, intervalMs, intervalMs);
    }
  }

  private stopTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  dispose(): void {
    this.stopped = true;
    this.stopTimers();
    for (const collector of Object.values(this.collectors)) collector.dispose();
  }
}
