/* ============================================================
   Metric payloads produced by the backend collectors and
   consumed by the frontend cards / sparklines.

   Every field is optional: collectors degrade gracefully when a
   host doesn't expose a given source (no thermal zones, BusyBox
   df, etc). A missing field means "unknown", never zero.
   ============================================================ */

export interface DiskMetric {
  /** Mount point, e.g. "/" or "/home". */
  mount: string;
  usedBytes: number;
  totalBytes: number;
  usedPct: number;
}

export interface TempMetric {
  /** Sensor label, e.g. "cpu-thermal" or "thermal_zone0". */
  label: string;
  celsius: number;
}

export interface NetMetric {
  /** Interface name, e.g. "enp5s0". */
  iface: string;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  rxBytesTotal: number;
  txBytesTotal: number;
}

export interface DeviceMetrics {
  device: string;
  /** Epoch milliseconds when this sample was taken. */
  timestamp: number;
  /** Which collector produced it. */
  source: "ssh" | "openwrt" | "exporter";
  ok: boolean;
  error?: string;

  cpuPct?: number;
  /** 1/5/15-minute load averages. */
  loadavg?: [number, number, number];
  cpuCount?: number;

  memUsedBytes?: number;
  memTotalBytes?: number;
  memPct?: number;
  swapUsedBytes?: number;
  swapTotalBytes?: number;
  swapPct?: number;

  uptimeSec?: number;
  disks?: DiskMetric[];
  temps?: TempMetric[];
  net?: NetMetric[];
}

/** A single point in the history ring buffer. Deliberately narrow —
 *  history exists to draw sparklines, not to be a time-series DB. */
export interface MetricSample {
  t: number;
  cpu?: number;
  mem?: number;
  temp?: number;
  rx?: number;
  tx?: number;
}

export interface MetricsHistory {
  device: string;
  samples: MetricSample[];
}

export function toSample(m: DeviceMetrics): MetricSample {
  const sample: MetricSample = { t: m.timestamp };
  if (m.cpuPct !== undefined) sample.cpu = round1(m.cpuPct);
  if (m.memPct !== undefined) sample.mem = round1(m.memPct);
  const hottest = m.temps?.reduce<number | undefined>(
    (max, t) => (max === undefined || t.celsius > max ? t.celsius : max),
    undefined,
  );
  if (hottest !== undefined) sample.temp = round1(hottest);
  const primary = m.net?.[0];
  if (primary) {
    sample.rx = Math.round(primary.rxBytesPerSec);
    sample.tx = Math.round(primary.txBytesPerSec);
  }
  return sample;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
