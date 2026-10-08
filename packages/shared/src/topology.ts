import { z } from "zod";

/* ============================================================
   netmap HostGraph — the JSON emitted by
   `netmap scan <cidr> --no-tui --output graph.json`.

   Mirrors the Rust types in netmap/src/model.rs. serde
   serializes unit-variant enums as their PascalCase variant
   name and IpAddr as a plain string, so `hosts` arrives as an
   object keyed by IP.

   Parsed with zod rather than trusted: the file is produced by
   a separate container that may be running an older netmap.
   ============================================================ */

export const DEVICE_ROLES = [
  "Gateway",
  "Switch",
  "WirelessAP",
  "Server",
  "Workstation",
  "IoT",
  "Unknown",
] as const;
export type NetmapRole = (typeof DEVICE_ROLES)[number];

/** Role → the dashboard accent token used to colour the node. */
export const ROLE_ACCENT: Record<NetmapRole, string> = {
  Gateway: "var(--accent-router)",
  Switch: "var(--accent-server-arm)",
  WirelessAP: "var(--accent-server-arm)",
  Server: "var(--accent-server-x86)",
  Workstation: "var(--accent-nav)",
  IoT: "var(--purple)",
  Unknown: "var(--accent-legacy)",
};

export const NetmapPortSchema = z.object({
  number: z.number(),
  protocol: z.enum(["Tcp", "Udp"]),
  service: z.string().nullish(),
});
export type NetmapPort = z.infer<typeof NetmapPortSchema>;

export const NetmapHostSchema = z.object({
  ip: z.string(),
  mac: z.string().nullish(),
  hostname: z.string().nullish(),
  vendor: z.string().nullish(),
  open_ports: z.array(NetmapPortSchema).default([]),
  os_guess: z.string().nullish(),
  role: z.enum(DEVICE_ROLES).catch("Unknown"),
  detected_by: z.array(z.string()).default([]),
  hop_distance: z.number().nullish(),
});
export type NetmapHost = z.infer<typeof NetmapHostSchema>;

export const HopEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  hop_index: z.number(),
});
export type HopEdge = z.infer<typeof HopEdgeSchema>;

export const HostGraphSchema = z.object({
  hosts: z.record(z.string(), NetmapHostSchema),
  edges: z.array(HopEdgeSchema).default([]),
  gateway: z.string().nullish(),
});
export type HostGraph = z.infer<typeof HostGraphSchema>;

/** What GET /api/topology returns. */
export interface TopologySnapshot {
  graph: HostGraph | null;
  /** Epoch ms of the graph file's mtime, or null when no scan has run. */
  scannedAt: number | null;
  /** True while the sidecar has an outstanding scan trigger. */
  scanning: boolean;
  error?: string;
}
