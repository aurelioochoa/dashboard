/* ============================================================
   health.ts — server-side reachability probes.

   Replaces the config.yaml `status: active` strings, which were
   only ever as accurate as the last time someone hand-edited
   them. HTTP targets come from `web` and `links[]`; TCP targets
   from `port_map`/`ports`.

   Runs from the backend rather than the browser so it can open
   raw TCP sockets and isn't blocked by CORS.
   ============================================================ */

import { connect } from "node:net";
import { request } from "undici";
import { healthId, type Config, type Device, type HealthResult } from "@homelab/shared";
import { env } from "./env.js";
import { publish } from "./events.js";

/** Probe fan-out cap: old hosts and small routers are slow, and a burst of
 *  simultaneous connects is exactly the wrong way to treat them. */
const CONCURRENCY = 8;

const results = new Map<string, HealthResult>();
let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function latestHealth(): HealthResult[] {
  return [...results.values()];
}

interface Target {
  device: string;
  kind: "http" | "tcp";
  target: string;
  label: string;
  host?: string;
  port?: number;
}

/** Everything worth probing for one device. */
export function targetsFor(device: Device): Target[] {
  const out: Target[] = [];

  if (device.web) {
    out.push({ device: device.name, kind: "http", target: device.web, label: "Panel Web" });
  }
  for (const link of device.links ?? []) {
    out.push({ device: device.name, kind: "http", target: link.url, label: link.label });
  }

  const ports = device.port_map?.length
    ? device.port_map.map((p) => ({ port: p.port, label: p.service ?? String(p.port) }))
    : (device.ports ?? []).map((p) => ({ port: p, label: String(p) }));

  for (const { port, label } of ports) {
    // UDP-only entries can't be probed by connecting, so skip them rather
    // than reporting a permanent false "down".
    const proto = device.port_map?.find((p) => p.port === port)?.proto ?? "";
    if (/^udp$/i.test(proto)) continue;

    out.push({
      device: device.name,
      kind: "tcp",
      target: `${device.ip}:${port}`,
      label,
      host: device.ip,
      port,
    });
  }

  // De-duplicate: a link and `web` often point at the same URL.
  const seen = new Set<string>();
  return out.filter((t) => {
    const id = healthId(t.device, t.kind, t.target);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function probeHttp(t: Target): Promise<HealthResult> {
  const id = healthId(t.device, t.kind, t.target);
  const started = Date.now();
  const base = { id, device: t.device, kind: t.kind, target: t.target, label: t.label };

  try {
    const res = await request(t.target, {
      method: "GET",
      headersTimeout: env.probeTimeoutMs,
      bodyTimeout: env.probeTimeoutMs,
      maxRedirections: 0,
      headers: { "User-Agent": "homelab-dashboard/health" },
    });
    // Drain so the connection can be reused instead of leaking. dump()
    // rather than destroy(): destroying an in-flight body makes undici
    // emit an unhandled 'error' on the stream, which crashes the process.
    await res.body.dump().catch(() => undefined);

    // Anything that answered is up. A 401/403 from an admin UI means the
    // service is alive and guarding itself, which is exactly what we want
    // to see; only 5xx counts as broken.
    const state = res.statusCode < 500 ? "up" : "down";
    return { ...base, state, status: res.statusCode, responseMs: Date.now() - started, checkedAt: Date.now() };
  } catch (err) {
    return {
      ...base,
      state: "down",
      error: err instanceof Error ? err.message : String(err),
      checkedAt: Date.now(),
    };
  }
}

function probeTcp(t: Target): Promise<HealthResult> {
  const id = healthId(t.device, t.kind, t.target);
  const started = Date.now();
  const base = { id, device: t.device, kind: t.kind, target: t.target, label: t.label };

  return new Promise((resolve) => {
    const socket = connect({ host: t.host!, port: t.port!, timeout: env.probeTimeoutMs });
    let settled = false;

    const finish = (result: HealthResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.once("connect", () =>
      finish({ ...base, state: "up", responseMs: Date.now() - started, checkedAt: Date.now() }),
    );
    socket.once("timeout", () =>
      finish({ ...base, state: "down", error: "Connection timed out", checkedAt: Date.now() }),
    );
    socket.once("error", (err) =>
      finish({ ...base, state: "down", error: err.message, checkedAt: Date.now() }),
    );
  });
}

async function runAll(config: Config): Promise<HealthResult[]> {
  const targets = config.devices.flatMap(targetsFor);
  const out: HealthResult[] = [];

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map((t) => (t.kind === "http" ? probeHttp(t) : probeTcp(t))),
    );
    out.push(...settled);
  }
  return out;
}

/** Probe everything once and broadcast the result. */
export async function probeNow(config: Config): Promise<HealthResult[]> {
  if (inFlight) return latestHealth();
  inFlight = true;
  try {
    const fresh = await runAll(config);
    results.clear();
    for (const r of fresh) results.set(r.id, r);
    publish({ type: "health", data: fresh });
    return fresh;
  } finally {
    inFlight = false;
  }
}

export function startHealthChecks(getConfig: () => Config | null): void {
  stopHealthChecks();

  const tick = async (): Promise<void> => {
    const config = getConfig();
    if (config) {
      try {
        await probeNow(config);
      } catch {
        // Never let a probe failure kill the loop.
      }
    }
    timer = setTimeout(() => void tick(), env.healthInterval * 1000);
    timer.unref?.();
  };

  void tick();
}

export function stopHealthChecks(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  results.clear();
}
