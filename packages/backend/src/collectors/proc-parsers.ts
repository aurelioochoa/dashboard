/* ============================================================
   proc-parsers.ts — pure parsers for the text the ssh collector
   reads out of /proc, /sys and `df`.

   Deliberately free of I/O so every quirk can be pinned with a
   fixture: the three target hosts are Arch x86_64, Armbian
   aarch64 and Alpine i686 with BusyBox coreutils, and they do
   not agree on much.

   Every function returns undefined rather than throwing when the
   input is missing or unrecognised — a host without thermal
   zones must still report CPU and RAM.
   ============================================================ */

import type { DiskMetric, NetMetric, TempMetric } from "@homelab/shared";

/* ─── /proc/stat ─── */

export interface CpuTimes {
  /** Sum of every field: the total jiffies elapsed. */
  total: number;
  /** idle + iowait. */
  idle: number;
}

/** Parse the aggregate `cpu` line. CPU% needs two samples — see cpuPercent. */
export function parseProcStat(text: string): CpuTimes | undefined {
  const line = text.split("\n").find((l) => /^cpu\s/.test(l));
  if (!line) return undefined;

  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((n) => !Number.isFinite(n))) return undefined;

  const total = fields.reduce((sum, n) => sum + n, 0);
  // user nice system idle iowait irq softirq steal guest guest_nice
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  return { total, idle };
}

/** Utilisation between two /proc/stat samples, as a 0-100 percentage. */
export function cpuPercent(prev: CpuTimes, next: CpuTimes): number | undefined {
  const totalDelta = next.total - prev.total;
  const idleDelta = next.idle - prev.idle;
  // A counter reset (reboot) or a zero-length window yields nothing useful.
  if (totalDelta <= 0) return undefined;
  const pct = ((totalDelta - idleDelta) / totalDelta) * 100;
  return clampPct(pct);
}

/** Number of `cpuN` lines in /proc/stat. */
export function parseCpuCount(text: string): number | undefined {
  const count = text.split("\n").filter((l) => /^cpu\d+\s/.test(l)).length;
  return count > 0 ? count : undefined;
}

/* ─── /proc/meminfo ─── */

export interface MemInfo {
  totalBytes: number;
  usedBytes: number;
  usedPct: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  swapPct: number;
}

export function parseMemInfo(text: string): MemInfo | undefined {
  const kb = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (m?.[1] && m[2]) kb.set(m[1], Number(m[2]));
  }

  const total = kb.get("MemTotal");
  if (!total) return undefined;

  // MemAvailable accounts for reclaimable page cache and is what every
  // modern kernel reports. Older kernels (pre-3.14) lack it and
  // need the free+buffers+cached approximation.
  const available =
    kb.get("MemAvailable") ??
    (kb.get("MemFree") ?? 0) + (kb.get("Buffers") ?? 0) + (kb.get("Cached") ?? 0);

  const used = Math.max(0, total - available);
  const swapTotal = kb.get("SwapTotal") ?? 0;
  const swapFree = kb.get("SwapFree") ?? 0;
  const swapUsed = Math.max(0, swapTotal - swapFree);

  return {
    totalBytes: total * 1024,
    usedBytes: used * 1024,
    usedPct: clampPct((used / total) * 100) ?? 0,
    swapTotalBytes: swapTotal * 1024,
    swapUsedBytes: swapUsed * 1024,
    swapPct: swapTotal > 0 ? (clampPct((swapUsed / swapTotal) * 100) ?? 0) : 0,
  };
}

/* ─── /proc/loadavg ─── */

export function parseLoadAvg(text: string): [number, number, number] | undefined {
  const parts = text.trim().split(/\s+/);
  const nums = parts.slice(0, 3).map(Number);
  if (nums.length < 3 || nums.some((n) => !Number.isFinite(n))) return undefined;
  return [nums[0]!, nums[1]!, nums[2]!];
}

/* ─── /proc/uptime ─── */

export function parseUptime(text: string): number | undefined {
  const first = Number(text.trim().split(/\s+/)[0]);
  return Number.isFinite(first) ? first : undefined;
}

/* ─── df -P -k ─── */

/** Pseudo-filesystems that would otherwise clutter the card. */
const SKIP_FS = /^(tmpfs|devtmpfs|overlay|squashfs|udev|none|shm|efivarfs|ramfs)$/i;
const SKIP_MOUNT = /^\/(dev|proc|sys|run)(\/|$)/;

/**
 * Parse POSIX `df -P -k` output.
 *
 * `-P` is what makes this portable: it forces one record per line, so a
 * long device name can't wrap onto a second line the way BusyBox and
 * coreutils both otherwise allow. `-k` is used instead of `-B1` because
 * BusyBox df on Alpine has no `-B`.
 */
export function parseDf(text: string): DiskMetric[] {
  const out: DiskMetric[] = [];
  const lines = text.trim().split("\n").slice(1); // drop the header

  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;

    const [source, totalK, usedK] = cols;
    const mount = cols.slice(5).join(" "); // mount points may contain spaces
    if (!source || !mount) continue;
    if (SKIP_FS.test(source) || SKIP_MOUNT.test(mount)) continue;

    const total = Number(totalK) * 1024;
    const used = Number(usedK) * 1024;
    if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) continue;

    out.push({
      mount,
      totalBytes: total,
      usedBytes: used,
      usedPct: clampPct((used / total) * 100) ?? 0,
    });
  }

  // Biggest filesystems first — that's what you want to see on a card.
  return out.sort((a, b) => b.totalBytes - a.totalBytes);
}

/* ─── /sys/class/thermal ─── */

/**
 * Parse the paired `type`/`temp` readings the collector emits as
 * "<label>=<millidegrees>" lines.
 *
 * Values arrive in millidegrees on every mainstream driver, but some
 * report plain degrees, so anything under 200 is taken at face value.
 */
export function parseThermal(text: string): TempMetric[] {
  const out: TempMetric[] = [];
  // Zone `type` is not unique — an x86 box routinely reports several
  // zones all called "acpitz". Suffix repeats so each bar has its own name.
  const seen = new Map<string, number>();

  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(.+?)=(-?\d+)$/);
    if (!m?.[1] || m[2] === undefined) continue;
    const raw = Number(m[2]);
    if (!Number.isFinite(raw)) continue;

    const celsius = Math.abs(raw) >= 200 ? raw / 1000 : raw;
    // Filter obvious nonsense: disabled zones report 0 or huge sentinels.
    if (celsius <= 0 || celsius > 150) continue;

    const base = m[1];
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);

    out.push({
      label: n === 0 ? base : `${base} ${n + 1}`,
      celsius: Math.round(celsius * 10) / 10,
    });
  }
  return out.sort((a, b) => b.celsius - a.celsius);
}

/* ─── /proc/net/dev ─── */

export interface IfaceCounters {
  iface: string;
  rxBytes: number;
  txBytes: number;
}

const SKIP_IFACE = /^(lo|docker\d+|br-[0-9a-f]{12}|veth|virbr|tun|tap|wg)/;

export function parseNetDev(text: string): IfaceCounters[] {
  const out: IfaceCounters[] = [];
  for (const line of text.split("\n").slice(2)) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m?.[1] || !m[2]) continue;

    const iface = m[1].trim();
    if (SKIP_IFACE.test(iface)) continue;

    const fields = m[2].trim().split(/\s+/).map(Number);
    const rx = fields[0];
    const tx = fields[8];
    if (rx === undefined || tx === undefined) continue;
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    // An interface that has never seen a byte is almost certainly down.
    if (rx === 0 && tx === 0) continue;

    out.push({ iface, rxBytes: rx, txBytes: tx });
  }
  return out;
}

/** Turn two counter samples into per-second rates. */
export function netRates(
  prev: IfaceCounters[],
  next: IfaceCounters[],
  elapsedMs: number,
): NetMetric[] {
  if (elapsedMs <= 0) return [];
  const seconds = elapsedMs / 1000;
  const before = new Map(prev.map((c) => [c.iface, c]));

  const out: NetMetric[] = [];
  for (const cur of next) {
    const old = before.get(cur.iface);
    if (!old) continue;
    const rxDelta = cur.rxBytes - old.rxBytes;
    const txDelta = cur.txBytes - old.txBytes;
    // Negative deltas mean the 32-bit counter wrapped or the host rebooted.
    if (rxDelta < 0 || txDelta < 0) continue;

    out.push({
      iface: cur.iface,
      rxBytesPerSec: rxDelta / seconds,
      txBytesPerSec: txDelta / seconds,
      rxBytesTotal: cur.rxBytes,
      txBytesTotal: cur.txBytes,
    });
  }
  // Busiest interface first: metrics.ts shows only the primary one.
  return out.sort(
    (a, b) => b.rxBytesPerSec + b.txBytesPerSec - (a.rxBytesPerSec + a.txBytesPerSec),
  );
}

function clampPct(n: number): number | undefined {
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}
