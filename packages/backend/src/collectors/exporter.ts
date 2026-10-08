/* ============================================================
   exporter.ts — Prometheus text-format collector.

   Lets any device opt into node_exporter (or anything else
   speaking the same exposition format) by setting
   `metrics: { type: exporter, url: ... }` in config.yaml, with
   no code change. The SSH collector remains the default because
   it needs nothing installed on the target.
   ============================================================ */

import { request } from "undici";
import { resolveMetricsSource, type Device, type DeviceMetrics } from "@homelab/shared";
import type { DiskMetric, NetMetric, TempMetric } from "@homelab/shared";
import { failed, type MetricsCollector } from "./types.js";

const TIMEOUT_MS = 6000;

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * Parse the Prometheus text exposition format.
 *
 * Deliberately minimal: comments dropped, one sample per line,
 * `name{label="value",...} number [timestamp]`.
 */
export function parsePrometheus(text: string): PromSample[] {
  const out: PromSample[] = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*?\})?\s+(.+)$/);
    if (!match?.[1] || match[3] === undefined) continue;

    // A trailing timestamp is optional; the value is the first token.
    const value = Number(match[3].trim().split(/\s+/)[0]);
    if (!Number.isFinite(value)) continue;

    out.push({ name: match[1], labels: parseLabels(match[2]), value });
  }
  return out;
}

function parseLabels(block: string | undefined): Record<string, string> {
  if (!block) return {};
  const labels: Record<string, string> = {};
  const inner = block.slice(1, -1);
  // Values may contain commas and escaped quotes, so match pairs rather
  // than splitting on ",".
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    if (m[1] !== undefined && m[2] !== undefined) {
      labels[m[1]] = m[2].replace(/\\(.)/g, "$1");
    }
  }
  return labels;
}

/** Derive DeviceMetrics fields from a node_exporter scrape. */
export function fromNodeExporter(device: string, samples: PromSample[]): DeviceMetrics {
  const metrics: DeviceMetrics = { device, timestamp: Date.now(), source: "exporter", ok: true };
  const by = (name: string): PromSample[] => samples.filter((s) => s.name === name);

  // CPU: node_cpu_seconds_total is a counter, so utilisation needs the
  // idle share across cores. With a single scrape the best available
  // signal is load1 normalised by core count.
  const cores = new Set(by("node_cpu_seconds_total").map((s) => s.labels["cpu"])).size || 1;
  const load1 = by("node_load1")[0]?.value;
  if (load1 !== undefined) {
    metrics.loadavg = [load1, by("node_load5")[0]?.value ?? 0, by("node_load15")[0]?.value ?? 0];
    metrics.cpuPct = Math.round(Math.min(100, (load1 / cores) * 100) * 10) / 10;
    metrics.cpuCount = cores;
  }

  const memTotal = by("node_memory_MemTotal_bytes")[0]?.value;
  const memAvail = by("node_memory_MemAvailable_bytes")[0]?.value;
  if (memTotal && memAvail !== undefined) {
    const used = Math.max(0, memTotal - memAvail);
    metrics.memTotalBytes = memTotal;
    metrics.memUsedBytes = used;
    metrics.memPct = Math.round((used / memTotal) * 1000) / 10;
  }

  const boot = by("node_boot_time_seconds")[0]?.value;
  if (boot) metrics.uptimeSec = Math.max(0, Date.now() / 1000 - boot);

  const disks = collectDisks(by("node_filesystem_size_bytes"), by("node_filesystem_avail_bytes"));
  if (disks.length) metrics.disks = disks;

  const temps = collectTemps(by("node_hwmon_temp_celsius"), by("node_thermal_zone_temp"));
  if (temps.length) metrics.temps = temps;

  const net = collectNet(by("node_network_receive_bytes_total"), by("node_network_transmit_bytes_total"));
  if (net.length) metrics.net = net;

  return metrics;
}

function collectDisks(sizes: PromSample[], avails: PromSample[]): DiskMetric[] {
  const availBy = new Map(avails.map((s) => [s.labels["mountpoint"], s.value]));
  const out: DiskMetric[] = [];

  for (const size of sizes) {
    const mount = size.labels["mountpoint"];
    const fstype = size.labels["fstype"] ?? "";
    if (!mount || size.value <= 0) continue;
    if (/^(tmpfs|devtmpfs|overlay|squashfs|ramfs)$/i.test(fstype)) continue;
    if (/^\/(dev|proc|sys|run)(\/|$)/.test(mount)) continue;

    const avail = availBy.get(mount);
    if (avail === undefined) continue;

    const used = Math.max(0, size.value - avail);
    out.push({
      mount,
      totalBytes: size.value,
      usedBytes: used,
      usedPct: Math.round((used / size.value) * 1000) / 10,
    });
  }
  return out.sort((a, b) => b.totalBytes - a.totalBytes);
}

function collectTemps(hwmon: PromSample[], zones: PromSample[]): TempMetric[] {
  const out: TempMetric[] = [];
  for (const s of hwmon) {
    const label = s.labels["sensor"] ?? s.labels["chip"] ?? "hwmon";
    if (s.value > 0 && s.value < 150) out.push({ label, celsius: Math.round(s.value * 10) / 10 });
  }
  for (const s of zones) {
    const label = s.labels["type"] ?? s.labels["zone"] ?? "thermal";
    if (s.value > 0 && s.value < 150) out.push({ label, celsius: Math.round(s.value * 10) / 10 });
  }
  return out.sort((a, b) => b.celsius - a.celsius);
}

function collectNet(rx: PromSample[], tx: PromSample[]): NetMetric[] {
  const txBy = new Map(tx.map((s) => [s.labels["device"], s.value]));
  const out: NetMetric[] = [];

  for (const s of rx) {
    const iface = s.labels["device"];
    if (!iface || /^(lo|docker|veth|br-|virbr|tun|tap)/.test(iface)) continue;
    const txBytes = txBy.get(iface);
    if (txBytes === undefined) continue;
    // Rates need two scrapes; the store's previous sample supplies them.
    out.push({ iface, rxBytesPerSec: 0, txBytesPerSec: 0, rxBytesTotal: s.value, txBytesTotal: txBytes });
  }
  return out;
}

export class ExporterCollector implements MetricsCollector {
  readonly kind = "exporter" as const;
  private previous = new Map<string, { net: NetMetric[]; at: number }>();

  async collect(device: Device): Promise<DeviceMetrics> {
    const source = resolveMetricsSource(device);
    if (source.type !== "exporter") {
      return failed(device.name, "exporter", new Error("Device is not configured for an exporter"));
    }

    try {
      const res = await request(source.url, {
        method: "GET",
        headers: { Accept: "text/plain" },
        headersTimeout: TIMEOUT_MS,
        bodyTimeout: TIMEOUT_MS,
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`HTTP ${res.statusCode}`);
      }

      const metrics = fromNodeExporter(device.name, parsePrometheus(await res.body.text()));
      this.applyNetRates(device.name, metrics);
      return metrics;
    } catch (err) {
      return failed(device.name, "exporter", err);
    }
  }

  /** Counters become rates once we have a previous scrape to diff against. */
  private applyNetRates(name: string, metrics: DeviceMetrics): void {
    const now = metrics.timestamp;
    const prev = this.previous.get(name);

    if (metrics.net && prev) {
      const elapsed = (now - prev.at) / 1000;
      if (elapsed > 0) {
        const before = new Map(prev.net.map((n) => [n.iface, n]));
        for (const cur of metrics.net) {
          const old = before.get(cur.iface);
          if (!old) continue;
          const rxDelta = cur.rxBytesTotal - old.rxBytesTotal;
          const txDelta = cur.txBytesTotal - old.txBytesTotal;
          if (rxDelta < 0 || txDelta < 0) continue;
          cur.rxBytesPerSec = rxDelta / elapsed;
          cur.txBytesPerSec = txDelta / elapsed;
        }
        metrics.net.sort(
          (a, b) => b.rxBytesPerSec + b.txBytesPerSec - (a.rxBytesPerSec + a.txBytesPerSec),
        );
      }
    }

    if (metrics.net) {
      this.previous.set(name, { net: metrics.net.map((n) => ({ ...n })), at: now });
    }
  }

  release(deviceName: string): void {
    this.previous.delete(deviceName);
  }

  dispose(): void {
    this.previous.clear();
  }
}
