/* ============================================================
   env.ts — runtime configuration, all from environment vars.
   Resolved once at boot so misconfiguration fails loudly and
   early rather than on the first request.
   ============================================================ */

import { resolve } from "node:path";

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/** Like str(), but an explicitly empty value means "off" rather than
 *  "use the default" — needed so STATIC_DIR="" can disable static serving. */
function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined ? fallback : v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export const env = {
  host: str("HOST", "0.0.0.0"),
  port: int("PORT", 3000),

  /** Path to config.yaml. Relative values resolve against the process
   *  working directory — in Docker this is /app, so the compose mount
   *  lands at /app/config/config.yaml. */
  configPath: resolve(str("CONFIG_PATH", "config/config.yaml")),
  /** Where PUT /api/config writes timestamped backups. */
  backupDir: resolve(str("CONFIG_BACKUP_DIR", "config/backups")),
  /** Icons uploaded from the browser. Beside config.yaml on purpose:
   *  that directory is a bind mount, so uploads outlive a rebuild. */
  iconDir: resolve(str("ICON_DIR", "config/icons")),
  /** Static assets (the Vite build). Set to an empty string to disable
   *  static serving and run API-only. Relative paths resolve against the
   *  process working directory, so prefer absolute ones. */
  staticDir: optional("STATIC_DIR", resolve("packages/frontend/dist")),

  /** Upstream for the /router proxy that fronts the OpenWrt ubus endpoint. */
  routerUrl: str("ROUTER_URL", ""),

  /** Default SSH key used by the ssh collector when a device names none. */
  sshKeyPath: str("SSH_KEY_PATH", ""),
  /** Password for the OpenWrt ubus login, kept out of config.yaml. */
  openwrtPassword: str("OPENWRT_PASSWORD", ""),

  /** Directory the netmap sidecar writes graph.json into. */
  netmapDir: resolve(str("NETMAP_DIR", "/data/netmap")),

  /** Retained metric history per device, in samples. */
  historySize: int("HISTORY_SIZE", 720),
  /** How often reachability probes run, in seconds. */
  healthInterval: int("HEALTH_INTERVAL", 30),
  /** Per-probe timeout, in milliseconds. */
  probeTimeoutMs: int("PROBE_TIMEOUT_MS", 4000),

  logLevel: str("LOG_LEVEL", "info"),
} as const;

export type Env = typeof env;
