/* ============================================================
   search.ts — the index behind the command palette, plus a
   small subsequence matcher.

   Kept free of DOM access so the ranking is unit-testable.
   ============================================================ */

import type { Config, Device } from "@homelab/shared";

export type EntryKind = "device" | "service" | "port" | "container" | "link" | "tab" | "action";

export interface SearchEntry {
  id: string;
  kind: EntryKind;
  title: string;
  subtitle: string;
  icon: string;
  /** Extra text that should match but isn't displayed. */
  keywords?: string;
  device?: string;
  url?: string;
  copy?: string;
  tab?: string;
  action?: string;
}

export interface Match {
  entry: SearchEntry;
  score: number;
  /** Index ranges in `title` that matched, for highlighting. */
  ranges: Array<[number, number]>;
}

const KIND_WEIGHT: Record<EntryKind, number> = {
  device: 100,
  tab: 90,
  action: 85,
  link: 70,
  service: 60,
  container: 55,
  port: 40,
};

export function buildIndex(config: Config): SearchEntry[] {
  const entries: SearchEntry[] = [
    { id: "tab:dashboard", kind: "tab", title: "Dashboard", subtitle: "Ver dispositivos", icon: "▦", tab: "dashboard" },
    { id: "tab:topology", kind: "tab", title: "Topology", subtitle: "Mapa de red", icon: "🗺", tab: "topology" },
    { id: "tab:services", kind: "tab", title: "Servicios", subtitle: "Catálogo de servicios", icon: "⚡", tab: "services" },
    { id: "tab:config", kind: "tab", title: "Config", subtitle: "Editar config.yaml", icon: "⚙", tab: "config" },
    { id: "action:scan", kind: "action", title: "Escanear la red", subtitle: "Lanzar netmap ahora", icon: "◎", action: "scan" },
    { id: "action:probe", kind: "action", title: "Revisar servicios", subtitle: "Forzar health checks", icon: "◍", action: "probe" },
    { id: "action:shortcuts", kind: "action", title: "Atajos de teclado", subtitle: "Mostrar ayuda", icon: "⌨", action: "shortcuts" },
  ];

  for (const device of config.devices ?? []) {
    entries.push(...entriesForDevice(device));
  }
  return entries;
}

function entriesForDevice(device: Device): SearchEntry[] {
  const out: SearchEntry[] = [
    {
      id: `device:${device.name}`,
      kind: "device",
      title: device.name,
      subtitle: [device.ip, device.hostname, device.os].filter(Boolean).join(" · "),
      icon: device.avatar ?? "▪",
      keywords: [device.mac, device.role, ...(device.aliases ?? [])].filter(Boolean).join(" "),
      device: device.name,
      copy: device.ip,
    },
  ];

  if (device.web) {
    out.push({
      id: `link:${device.name}:web`,
      kind: "link",
      title: `${device.name} · Panel Web`,
      subtitle: device.web,
      icon: "↗",
      device: device.name,
      url: device.web,
    });
  }

  for (const link of device.links ?? []) {
    out.push({
      id: `link:${device.name}:${link.label}`,
      kind: "link",
      title: link.label,
      subtitle: `${device.name} · ${link.url}`,
      icon: "↗",
      device: device.name,
      url: link.url,
    });
  }

  for (const service of device.services ?? []) {
    out.push({
      id: `service:${device.name}:${service.name}`,
      kind: "service",
      title: service.name,
      subtitle: `${device.name} · servicio`,
      icon: "◆",
      keywords: service.info,
      device: device.name,
    });
  }

  for (const container of device.docker ?? []) {
    out.push({
      id: `container:${device.name}:${container.name}`,
      kind: "container",
      title: container.name,
      subtitle: `${device.name} · ${container.image ?? "container"}`,
      icon: "▣",
      keywords: container.info,
      device: device.name,
    });
  }

  const ports = device.port_map?.length
    ? device.port_map.map((p) => ({ port: p.port, label: p.service }))
    : (device.ports ?? []).map((p) => ({ port: p, label: undefined }));

  for (const { port, label } of ports) {
    out.push({
      id: `port:${device.name}:${port}`,
      kind: "port",
      title: `${port}${label ? ` · ${label}` : ""}`,
      subtitle: `${device.name} · ${device.ip}:${port}`,
      icon: "⁘",
      device: device.name,
      copy: String(port),
    });
  }

  return out;
}

/**
 * Rank entries against a query.
 *
 * Scoring favours, in order: a prefix match on the title, a contiguous
 * substring, then a scattered subsequence. Kind weight breaks ties so
 * devices outrank the ports that belong to them.
 */
export function search(entries: SearchEntry[], rawQuery: string, limit = 40): Match[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return entries
      .filter((e) => e.kind === "tab" || e.kind === "device" || e.kind === "action")
      .slice(0, limit)
      .map((entry) => ({ entry, score: KIND_WEIGHT[entry.kind], ranges: [] }));
  }

  const matches: Match[] = [];
  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    let score: number | null = null;
    let ranges: Array<[number, number]> = [];

    if (title.startsWith(query)) {
      score = 1000;
      ranges = [[0, query.length]];
    } else {
      const at = title.indexOf(query);
      if (at >= 0) {
        score = 800 - at;
        ranges = [[at, at + query.length]];
      } else {
        const sub = subsequence(title, query);
        if (sub) {
          score = 500 - sub.gaps;
          ranges = sub.ranges;
        } else {
          // Fall back to the hidden fields so "f0:2f" finds a MAC and
          // "deepseek" finds the container it runs in.
          const extra = `${entry.subtitle} ${entry.keywords ?? ""}`.toLowerCase();
          if (extra.includes(query)) score = 200;
        }
      }
    }

    if (score !== null) {
      matches.push({ entry, score: score + KIND_WEIGHT[entry.kind], ranges });
    }
  }

  return matches
    .sort((a, b) => b.score - a.score || a.entry.title.length - b.entry.title.length)
    .slice(0, limit);
}

/** Match every query char in order; report total gap size for scoring. */
function subsequence(
  haystack: string,
  needle: string,
): { gaps: number; ranges: Array<[number, number]> } | null {
  const ranges: Array<[number, number]> = [];
  let at = 0;
  let gaps = 0;
  let runStart = -1;

  for (const char of needle) {
    const found = haystack.indexOf(char, at);
    if (found < 0) return null;
    if (found !== at && runStart >= 0) {
      ranges.push([runStart, at]);
      runStart = -1;
    }
    if (runStart < 0) runStart = found;
    gaps += found - at;
    at = found + 1;
  }
  if (runStart >= 0) ranges.push([runStart, at]);

  return { gaps, ranges };
}
