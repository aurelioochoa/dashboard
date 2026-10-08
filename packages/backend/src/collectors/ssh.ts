/* ============================================================
   ssh.ts — metrics over SSH.

   One persistent connection per device: reconnecting per tick
   would cost a full handshake every few seconds, which matters
   on a 1.6 GHz Pentium M.

   Each tick runs a single command that cats the handful of files
   we need, separated by sentinels. One round-trip per poll keeps
   the load on constrained hosts negligible, and every section is
   optional so a host missing thermal zones still reports CPU/RAM.
   ============================================================ */

import { readFile } from "node:fs/promises";
import { Client, type ConnectConfig } from "ssh2";
import {
  resolveMetricsSource,
  type Device,
  type DeviceMetrics,
} from "@homelab/shared";
import { env } from "../env.js";
import { failed, type MetricsCollector } from "./types.js";
import {
  cpuPercent, netRates, parseCpuCount, parseDf, parseLoadAvg, parseMemInfo,
  parseNetDev, parseProcStat, parseThermal, parseUptime,
  type CpuTimes, type IfaceCounters,
} from "./proc-parsers.js";

const SENTINEL = "@@HL@@";
const CONNECT_TIMEOUT_MS = 8000;
const EXEC_TIMEOUT_MS = 12_000;

/**
 * One shell command per poll. `2>/dev/null || true` on every section so a
 * missing file (no thermal zones, no swap) yields an empty section rather
 * than a non-zero exit that would fail the whole tick.
 */
const PROBE_COMMAND = [
  `echo ${SENTINEL}stat`, "cat /proc/stat 2>/dev/null || true",
  `echo ${SENTINEL}mem`, "cat /proc/meminfo 2>/dev/null || true",
  `echo ${SENTINEL}load`, "cat /proc/loadavg 2>/dev/null || true",
  `echo ${SENTINEL}uptime`, "cat /proc/uptime 2>/dev/null || true",
  `echo ${SENTINEL}df`, "df -P -k 2>/dev/null || true",
  `echo ${SENTINEL}net`, "cat /proc/net/dev 2>/dev/null || true",
  `echo ${SENTINEL}thermal`,
  'for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] && ' +
    'echo "$(cat "$z/type" 2>/dev/null || basename "$z")=$(cat "$z/temp")"; done 2>/dev/null || true',
  `echo ${SENTINEL}end`,
].join("; ");

interface Session {
  client: Client;
  ready: Promise<Client>;
  /** Previous samples, needed to turn counters into rates. */
  prevCpu?: CpuTimes;
  prevNet?: IfaceCounters[];
  prevAt?: number;
}

export class SshCollector implements MetricsCollector {
  readonly kind = "ssh" as const;
  private sessions = new Map<string, Session>();
  private keyCache = new Map<string, Buffer>();

  async collect(device: Device): Promise<DeviceMetrics> {
    const source = resolveMetricsSource(device);
    if (source.type !== "ssh") {
      return failed(device.name, "ssh", new Error("Device is not configured for SSH metrics"));
    }

    try {
      const session = await this.session(device.name, {
        host: source.host ?? device.ip,
        port: source.port,
        username: source.user,
        privateKey: await this.key(source.key_path ?? env.sshKeyPath),
        readyTimeout: CONNECT_TIMEOUT_MS,
        // Keep NAT and the router's conntrack from dropping an idle session.
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
      });

      const output = await exec(session.client, PROBE_COMMAND);
      return this.toMetrics(device.name, session, output);
    } catch (err) {
      // Drop the session so the next tick reconnects rather than reusing
      // a half-dead channel.
      this.release(device.name);
      return failed(device.name, "ssh", err);
    }
  }

  private toMetrics(name: string, session: Session, output: string): DeviceMetrics {
    const sections = splitSections(output);
    const now = Date.now();

    const metrics: DeviceMetrics = { device: name, timestamp: now, source: "ssh", ok: true };

    const stat = sections.stat ? parseProcStat(sections.stat) : undefined;
    if (stat) {
      if (session.prevCpu) {
        const pct = cpuPercent(session.prevCpu, stat);
        if (pct !== undefined) metrics.cpuPct = pct;
      }
      session.prevCpu = stat;
      const cores = parseCpuCount(sections.stat!);
      if (cores !== undefined) metrics.cpuCount = cores;
    }

    const mem = sections.mem ? parseMemInfo(sections.mem) : undefined;
    if (mem) {
      metrics.memTotalBytes = mem.totalBytes;
      metrics.memUsedBytes = mem.usedBytes;
      metrics.memPct = mem.usedPct;
      if (mem.swapTotalBytes > 0) {
        metrics.swapTotalBytes = mem.swapTotalBytes;
        metrics.swapUsedBytes = mem.swapUsedBytes;
        metrics.swapPct = mem.swapPct;
      }
    }

    const load = sections.load ? parseLoadAvg(sections.load) : undefined;
    if (load) metrics.loadavg = load;

    const uptime = sections.uptime ? parseUptime(sections.uptime) : undefined;
    if (uptime !== undefined) metrics.uptimeSec = uptime;

    if (sections.df) {
      const disks = parseDf(sections.df);
      if (disks.length) metrics.disks = disks;
    }

    if (sections.thermal) {
      const temps = parseThermal(sections.thermal);
      if (temps.length) metrics.temps = temps;
    }

    if (sections.net) {
      const counters = parseNetDev(sections.net);
      if (session.prevNet && session.prevAt) {
        const rates = netRates(session.prevNet, counters, now - session.prevAt);
        if (rates.length) metrics.net = rates;
      }
      session.prevNet = counters;
    }

    session.prevAt = now;

    // A tick that produced no usable field at all means the host answered
    // but told us nothing — report it as a failure rather than a blank card.
    if (metrics.cpuPct === undefined && metrics.memPct === undefined && !metrics.disks) {
      return failed(name, "ssh", new Error("No readable metrics on host"));
    }
    return metrics;
  }

  private async session(name: string, config: ConnectConfig): Promise<Session> {
    const existing = this.sessions.get(name);
    if (existing) {
      await existing.ready;
      return existing;
    }

    const client = new Client();
    const ready = new Promise<Client>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`SSH connect timed out after ${CONNECT_TIMEOUT_MS}ms`)),
        CONNECT_TIMEOUT_MS,
      );
      client.once("ready", () => {
        clearTimeout(timer);
        resolve(client);
      });
      client.once("error", (err) => {
        clearTimeout(timer);
        this.sessions.delete(name);
        reject(err);
      });
      client.once("close", () => this.sessions.delete(name));
      client.connect(config);
    });

    const session: Session = { client, ready };
    this.sessions.set(name, session);
    await ready;
    return session;
  }

  private async key(path: string): Promise<Buffer | undefined> {
    if (!path) return undefined;
    const cached = this.keyCache.get(path);
    if (cached) return cached;
    const buf = await readFile(path);
    this.keyCache.set(path, buf);
    return buf;
  }

  release(deviceName: string): void {
    const session = this.sessions.get(deviceName);
    if (!session) return;
    this.sessions.delete(deviceName);
    try {
      session.client.end();
    } catch {
      // Already closed.
    }
  }

  dispose(): void {
    for (const name of [...this.sessions.keys()]) this.release(name);
    this.keyCache.clear();
  }
}

/** Run one command and collect stdout. */
function exec(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`SSH exec timed out after ${EXEC_TIMEOUT_MS}ms`)),
      EXEC_TIMEOUT_MS,
    );

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      let out = "";
      stream.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      stream.on("close", () => {
        clearTimeout(timer);
        resolve(out);
      });
      stream.on("error", (streamErr: Error) => {
        clearTimeout(timer);
        reject(streamErr);
      });
      // stderr is intentionally drained and discarded: the probe command
      // silences errors itself, and an unread stream would stall the channel.
      stream.stderr.resume();
    });
  });
}

/** Split the sentinel-delimited probe output into named sections. */
export function splitSections(output: string): Record<string, string | undefined> {
  const sections: Record<string, string | undefined> = {};
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (current) sections[current] = buffer.join("\n").trim() || undefined;
    buffer = [];
  };

  for (const line of output.split("\n")) {
    if (line.startsWith(SENTINEL)) {
      flush();
      current = line.slice(SENTINEL.length).trim();
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();

  delete sections["end"];
  return sections;
}
