/* ============================================================
   Pure formatting helpers + shared display constants.
   Ported from the original src/frontend/js/format.js — no DOM
   access, no side effects, so both ends can use them and they
   are trivially unit-testable.
   ============================================================ */

import type { DeviceType } from "./config.js";

/** Per-device-type avatar tint. */
export const TYPE_TINT: Record<DeviceType, string> = {
  router: "rgba(245,158,11,0.14)",
  "server-x86": "rgba(96,165,250,0.14)",
  "server-arm": "rgba(45,212,191,0.14)",
  legacy: "rgba(107,122,153,0.18)",
};

/** OS label → CSS class for the OS badge. First match wins. */
export const OS_CLASSES: ReadonlyArray<{ match: RegExp; cls: string }> = [
  { match: /openwrt/i, cls: "os-openwrt" },
  { match: /arch/i, cls: "os-arch" },
  { match: /armbian|debian/i, cls: "os-armbian" },
  { match: /alpine/i, cls: "os-alpine" },
];

export function osClass(os: string | undefined): string {
  if (!os) return "os-generic";
  for (const entry of OS_CLASSES) {
    if (entry.match.test(os)) return entry.cls;
  }
  return "os-generic";
}

export function inferType(role: string | undefined): DeviceType {
  if (!role) return "server-x86";
  if (/router/i.test(role)) return "router";
  return "server-x86";
}

export function shortOs(os: string | undefined): string {
  if (!os) return "";
  const m = os.match(/^([A-Za-z]+)[\s_-]*v?(\d+(?:\.\d+)?)/);
  if (m) return `${m[1]} ${m[2]}`.trim();
  const parts = os.split(/\s+/).slice(0, 2).join(" ");
  return parts.length > 14 ? parts.slice(0, 14) : parts;
}

/** Collapse "firewall (nftables)" → "firewall" */
export function shortServiceName(name: string): string {
  return name.replace(/\s*\(.*?\)\s*/g, "").trim();
}

/** "Dropbear SSH" → "SSH" ; "dnsmasq (DNS/DHCP)" → "dnsmasq" ; "Grafana API" → "API" */
export function shortPortService(s: string | undefined): string {
  if (!s) return "";
  const cleaned = s.replace(/\s*\(.*?\)\s*/g, "").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]!;
    if (/^(ssh|http|https|dns|api|web)$/i.test(last)) return last.toUpperCase();
    return parts[0]!;
  }
  return parts[0] ?? "";
}

/** Bar colour for a 0-100 utilisation value: accent → amber → red. */
export function healthColor(value: number, type: string): string {
  if (value > 80) return "var(--red)";
  if (value > 60) return "var(--amber)";
  return `var(--accent-${type})`;
}

/** Compact byte formatting for disk/memory/network readouts. */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const neg = bytes < 0;
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? Math.round(value) : Number(value.toFixed(digits));
  return `${neg ? "-" : ""}${rounded} ${units[unit]}`;
}

/** Bytes-per-second with a /s suffix. */
export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec, 1)}/s`;
}

/** 93784 → "1d 2h 3m" */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
