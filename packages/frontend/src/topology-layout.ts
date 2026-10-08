/* ============================================================
   topology-layout.ts — turn a netmap HostGraph into positioned
   nodes and edges.

   Pure: no DOM, no SVG. Keeping the geometry separate from the
   drawing means the layout can be unit-tested against a real
   `netmap scan --output` capture.

   Layout is hierarchical by hop distance rather than
   force-directed: a home LAN is a shallow tree, and a stable,
   predictable arrangement beats an organic one that reshuffles
   on every scan.
   ============================================================ */

import type { Config, Device, HostGraph, NetmapHost, NetmapRole } from "@homelab/shared";

export interface LayoutNode {
  id: string;
  ip: string;
  /** Config device name when matched, else hostname or IP. */
  label: string;
  sublabel: string;
  role: NetmapRole;
  /** True when this host matched an entry in config.yaml. */
  known: boolean;
  /** The matched config device, for click-through. */
  device?: Device;
  host?: NetmapHost;
  tier: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  tiers: Array<{ index: number; label: string; y: number }>;
  width: number;
  height: number;
}

const NODE_W = 150;
const NODE_H = 52;
const GAP_X = 26;
const GAP_Y = 92;
const PAD = 40;

const TIER_LABELS = ["Gateway", "LAN", "Hop 2", "Hop 3", "Hop 4"];

/** Normalise a MAC for comparison — netmap and config.yaml differ on case. */
function normMac(mac: string | null | undefined): string {
  return (mac ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
}

/**
 * Match a discovered host to a configured device.
 *
 * MAC first: it survives DHCP moving a host to a new address. IP is the
 * fallback, plus upstream_ip so the router matches on either interface.
 */
export function matchDevice(host: NetmapHost, devices: Device[]): Device | undefined {
  const mac = normMac(host.mac);
  if (mac) {
    const byMac = devices.find((d) => normMac(d.mac) === mac);
    if (byMac) return byMac;
  }
  return devices.find((d) => d.ip === host.ip || d.upstream_ip === host.ip);
}

export function buildLayout(graph: HostGraph, config: Config): Layout {
  const devices = config.devices ?? [];
  const hosts = Object.values(graph.hosts);

  // Tier 0 is the gateway; everything reachable from it is tier 1, and so
  // on. hop_distance is used when traceroute supplied one.
  const tierOf = (host: NetmapHost): number => {
    if (graph.gateway && host.ip === graph.gateway) return 0;
    if (host.role === "Gateway") return 0;
    if (typeof host.hop_distance === "number" && host.hop_distance > 0) {
      return Math.min(host.hop_distance, TIER_LABELS.length - 1);
    }
    return 1;
  };

  const nodes: LayoutNode[] = hosts.map((host) => {
    const device = matchDevice(host, devices);
    return {
      id: host.ip,
      ip: host.ip,
      label: device?.name ?? host.hostname ?? host.ip,
      sublabel: host.ip,
      role: host.role,
      known: Boolean(device),
      device,
      host,
      tier: tierOf(host),
      x: 0,
      y: 0,
      width: NODE_W,
      height: NODE_H,
    };
  });

  // Group by tier, then sort within a tier so the order is stable across
  // scans: known devices first, then by numeric IP.
  const byTier = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    const list = byTier.get(node.tier) ?? [];
    list.push(node);
    byTier.set(node.tier, list);
  }

  const tierIndexes = [...byTier.keys()].sort((a, b) => a - b);
  let widest = 0;

  for (const tier of tierIndexes) {
    const list = byTier.get(tier)!;
    list.sort(
      (a, b) => Number(b.known) - Number(a.known) || ipValue(a.ip) - ipValue(b.ip),
    );
    widest = Math.max(widest, list.length * NODE_W + (list.length - 1) * GAP_X);
  }

  const width = Math.max(widest, NODE_W) + PAD * 2;

  const tiers: Layout["tiers"] = [];
  tierIndexes.forEach((tier, row) => {
    const list = byTier.get(tier)!;
    const rowWidth = list.length * NODE_W + (list.length - 1) * GAP_X;
    const startX = (width - rowWidth) / 2;
    const y = PAD + row * (NODE_H + GAP_Y);

    list.forEach((node, i) => {
      node.x = startX + i * (NODE_W + GAP_X);
      node.y = y;
    });

    tiers.push({ index: tier, label: TIER_LABELS[tier] ?? `Hop ${tier}`, y });
  });

  const positions = new Map(nodes.map((n) => [n.id, n]));
  const edges: LayoutEdge[] = [];
  const seen = new Set<string>();

  for (const edge of graph.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;

    // netmap can emit an edge in both directions; draw it once.
    const key = [edge.from, edge.to].sort().join("→");
    if (seen.has(key)) continue;
    seen.add(key);

    edges.push({
      from: edge.from,
      to: edge.to,
      fromX: from.x + from.width / 2,
      fromY: from.y + from.height,
      toX: to.x + to.width / 2,
      toY: to.y,
    });
  }

  const height = PAD * 2 + tierIndexes.length * NODE_H + Math.max(0, tierIndexes.length - 1) * GAP_Y;
  return { nodes, edges, tiers, width, height };
}

/** Sortable numeric value for an IPv4 address; IPv6 sorts last. */
function ipValue(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return Number.MAX_SAFE_INTEGER;
  return parts.reduce((acc, part) => acc * 256 + (Number(part) || 0), 0);
}

/** Neighbours of a node, for hover highlighting. */
export function neighboursOf(layout: Layout, id: string): Set<string> {
  const out = new Set<string>([id]);
  for (const edge of layout.edges) {
    if (edge.from === id) out.add(edge.to);
    if (edge.to === id) out.add(edge.from);
  }
  return out;
}
