/* ============================================================
   openwrt.ts — ubus JSON-RPC collector.

   Ported from the original browser-side src/frontend/js/openwrt.js.
   The protocol handling is unchanged; what moved is *where* it
   runs. Server-side means the router password lives in the
   backend environment instead of plaintext localStorage, and
   there is no CORS problem to work around.

   Targets OpenWrt 21.02+ (rpcd + uhttpd-mod-ubus). The legacy
   luci-mod-rpc package is not required.

     login   : ["<anon token>", "session", "login", {username, password}]
     sysinfo : ["<token>",      "system",  "info",  {}]

   Envelope: { result: [status, data] } where status 0 means OK.
   ============================================================ */

import { request } from "undici";
import { resolveMetricsSource, type Device, type DeviceMetrics } from "@homelab/shared";
import { env } from "../env.js";
import { failed, type MetricsCollector } from "./types.js";

const ANON_TOKEN = "00000000000000000000000000000000";
const TIMEOUT_MS = 6000;

/** ubus status codes, so an error surfaces as text rather than a number. */
export function ubusStatusMessage(code: number): string {
  switch (code) {
    case 1: return "Invalid command";
    case 2: return "Invalid argument";
    case 3: return "Method not found";
    case 4: return "Object not found";
    case 5: return "No data";
    case 6: return "Permission denied";
    case 7: return "Timeout";
    case 8: return "Not supported";
    case 9: return "Unknown error";
    case 10: return "Connection failed";
    default: return "ubus error";
  }
}

/** Session errors mean the token must be dropped and re-acquired. */
export function isSessionError(message: string): boolean {
  return /Permission denied|status 6|Invalid argument|status 2|401|403|session/i.test(message);
}

export function normalizeHost(host: string): string {
  const h = host.trim().replace(/\/+$/, "");
  if (!h) return "";
  if (/^https?:\/\//i.test(h)) return h;
  return `http://${h}`;
}

/** System info as returned by ubus `system info`. */
export interface SysInfo {
  uptimeSec: number;
  loadavg: [number, number, number];
  cpuPct: number;
  memPct: number;
  memTotalBytes: number;
  memUsedBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  swapPct: number;
}

/**
 * Shape a raw ubus `system info` payload.
 *
 * ubus reports load as fixed-point integers scaled by 65536, following
 * the kernel's getloadavg convention — dividing is required, not cosmetic.
 */
export function parseSysInfo(info: unknown, cpuCount = 1): SysInfo {
  const obj = (info ?? {}) as Record<string, unknown>;
  const loadRaw = Array.isArray(obj["load"]) ? (obj["load"] as unknown[]) : [0, 0, 0];
  const load = [0, 1, 2].map((i) => Number(loadRaw[i] ?? 0) / 65536) as [number, number, number];

  const mem = (obj["memory"] ?? {}) as Record<string, unknown>;
  const total = Number(mem["total"]) || 0;
  // Prefer MemAvailable-equivalent; fall back to free+buffered+cached.
  const available =
    mem["available"] != null
      ? Number(mem["available"])
      : (Number(mem["free"]) || 0) + (Number(mem["buffered"]) || 0) + (Number(mem["cached"]) || 0);
  const used = Math.max(0, total - available);

  const swap = (obj["swap"] ?? {}) as Record<string, unknown>;
  const swapTotal = Number(swap["total"]) || 0;
  const swapFree = Number(swap["free"]) || 0;
  const swapUsed = Math.max(0, swapTotal - swapFree);

  // Load average is the only CPU signal ubus exposes. Normalising by core
  // count keeps a 4-core router from reading 400%.
  const cores = Math.max(1, cpuCount);
  const cpuPct = Math.min(100, (load[0] / cores) * 100);

  return {
    uptimeSec: Number(obj["uptime"]) || 0,
    loadavg: load,
    cpuPct: Math.round(cpuPct * 10) / 10,
    memPct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    memTotalBytes: total,
    memUsedBytes: used,
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapUsed,
    swapPct: swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 1000) / 10 : 0,
  };
}

async function ubusCall(
  baseUrl: string,
  token: string,
  object: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await request(`${baseUrl}/ubus`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "call", params: [token, object, method, args] }),
    headersTimeout: TIMEOUT_MS,
    bodyTimeout: TIMEOUT_MS,
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode}`);
  }

  const data = (await res.body.json()) as {
    error?: { message?: string; code?: number };
    result?: unknown;
  };

  if (data.error) {
    const code = data.error.code != null ? ` (code ${data.error.code})` : "";
    throw new Error(`${data.error.message ?? "RPC error"}${code}`);
  }
  if (!Array.isArray(data.result)) throw new Error("Invalid RPC response");

  const status = Number(data.result[0]);
  if (status !== 0) throw new Error(`${ubusStatusMessage(status)} (ubus status ${status})`);
  return data.result[1];
}

export async function authenticate(host: string, user: string, pass: string): Promise<string> {
  const payload = (await ubusCall(normalizeHost(host), ANON_TOKEN, "session", "login", {
    username: user || "root",
    password: pass,
  })) as { ubus_rpc_session?: string } | undefined;

  if (!payload?.ubus_rpc_session) throw new Error("Login failed — no session token");
  return payload.ubus_rpc_session;
}

export class OpenWrtCollector implements MetricsCollector {
  readonly kind = "openwrt" as const;
  private tokens = new Map<string, string>();
  private cpuCounts = new Map<string, number>();

  async collect(device: Device): Promise<DeviceMetrics> {
    const source = resolveMetricsSource(device);
    if (source.type !== "openwrt") {
      return failed(device.name, "openwrt", new Error("Device is not configured for OpenWrt metrics"));
    }

    const host = normalizeHost(source.host ?? device.ip);
    // No password is not an error: rpcd can be configured to let the
    // unauthenticated session read `system info`, which is strictly better
    // than keeping a root password in the dashboard's environment. See the
    // README for the ACL. A password, when given, still takes precedence.
    const password = source.password ?? env.openwrtPassword;

    try {
      return await this.poll(device, host, source.user, password);
    } catch (err) {
      // One retry with a fresh session: tokens expire, and rpcd drops
      // sessions when the router reboots.
      const message = err instanceof Error ? err.message : String(err);
      // Only worth retrying when there is a session to re-establish; an
      // anonymous denial means the ACL is missing, and retrying won't help.
      if (password && isSessionError(message)) {
        this.tokens.delete(device.name);
        try {
          return await this.poll(device, host, source.user, password);
        } catch (retryErr) {
          return failed(device.name, "openwrt", retryErr);
        }
      }
      if (!password && /Access denied|denied|status 6|Permission/i.test(message)) {
        return failed(
          device.name,
          "openwrt",
          new Error(
            "Router denied anonymous access — install the rpcd ACL (see README) " +
              "or set OPENWRT_PASSWORD",
          ),
        );
      }
      return failed(device.name, "openwrt", err);
    }
  }

  private async poll(
    device: Device,
    host: string,
    user: string,
    password: string,
  ): Promise<DeviceMetrics> {
    const token = password
      ? await this.session(device.name, host, user, password)
      : ANON_TOKEN;

    const cores = await this.cpuCount(device.name, host, token);
    const info = parseSysInfo(await ubusCall(host, token, "system", "info"), cores);

    return {
      device: device.name,
      timestamp: Date.now(),
      source: "openwrt",
      ok: true,
      cpuPct: info.cpuPct,
      cpuCount: cores,
      loadavg: info.loadavg,
      memPct: info.memPct,
      memTotalBytes: info.memTotalBytes,
      memUsedBytes: info.memUsedBytes,
      ...(info.swapTotalBytes > 0
        ? { swapPct: info.swapPct, swapTotalBytes: info.swapTotalBytes, swapUsedBytes: info.swapUsedBytes }
        : {}),
      uptimeSec: info.uptimeSec,
    };
  }

  /** Cached authenticated session, re-used across polls. */
  private async session(name: string, host: string, user: string, password: string): Promise<string> {
    const cached = this.tokens.get(name);
    if (cached) return cached;
    const token = await authenticate(host, user, password);
    this.tokens.set(name, token);
    return token;
  }

  /** Core count, read once per device — it never changes at runtime. */
  private async cpuCount(name: string, host: string, token: string): Promise<number> {
    const cached = this.cpuCounts.get(name);
    if (cached) return cached;

    try {
      const board = (await ubusCall(host, token, "system", "board")) as
        | { system?: string }
        | undefined;
      // "MediaTek MT7628AN ver:1 eco:2" carries no core count, but SMP
      // boards report "N x <model>" — parse that when present.
      const match = board?.system?.match(/^(\d+)\s*x\s/i);
      const cores = match?.[1] ? Number(match[1]) : 1;
      this.cpuCounts.set(name, cores);
      return cores;
    } catch {
      // Not worth failing a poll over; assume single-core.
      return 1;
    }
  }

  release(deviceName: string): void {
    this.tokens.delete(deviceName);
    this.cpuCounts.delete(deviceName);
  }

  dispose(): void {
    this.tokens.clear();
    this.cpuCounts.clear();
  }
}
