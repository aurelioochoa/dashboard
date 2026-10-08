import { z } from "zod";

/* ============================================================
   config.yaml schema — the single source of truth for the
   dashboard's device data. Shared by the backend (parse +
   validate on load and on PUT /api/config) and the frontend
   (types for rendering).
   ============================================================ */

export const DEVICE_TYPES = ["router", "server-x86", "server-arm", "legacy"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/** How the backend collects metrics for a device. Optional — when
 *  omitted it is inferred from `integration` / `ssh`. */
export const MetricsSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ssh"),
    /** Defaults to the device `ip`. */
    host: z.string().optional(),
    port: z.number().int().positive().default(22),
    user: z.string().default("root"),
    /** Path inside the backend container. Falls back to SSH_KEY_PATH. */
    key_path: z.string().optional(),
    interval: z.number().int().positive().default(10),
  }),
  z.object({
    type: z.literal("openwrt"),
    /** Base URL of the ubus host. Defaults to http://<ip>. */
    host: z.string().optional(),
    user: z.string().default("root"),
    /** Prefer OPENWRT_PASSWORD in the environment over inlining it here. */
    password: z.string().optional(),
    interval: z.number().int().positive().default(5),
  }),
  z.object({
    type: z.literal("exporter"),
    /** Prometheus text-format endpoint, e.g. http://host:9100/metrics */
    url: z.string().url(),
    interval: z.number().int().positive().default(10),
  }),
  z.object({ type: z.literal("none") }),
]);
export type MetricsSource = z.infer<typeof MetricsSourceSchema>;

export const PortMapEntrySchema = z.object({
  port: z.number().int().min(0).max(65535),
  service: z.string().optional(),
  proto: z.string().optional(),
});
export type PortMapEntry = z.infer<typeof PortMapEntrySchema>;

export const ServiceSchema = z.object({
  name: z.string(),
  status: z.string().optional(),
  info: z.string().optional(),
});
export type Service = z.infer<typeof ServiceSchema>;

export const ContainerSchema = z.object({
  name: z.string(),
  image: z.string().optional(),
  status: z.string().optional(),
  info: z.string().optional(),
});
export type Container = z.infer<typeof ContainerSchema>;

export const LinkSchema = z.object({
  label: z.string(),
  url: z.string(),
});
export type Link = z.infer<typeof LinkSchema>;

export const DeviceSchema = z.object({
  name: z.string().min(1),
  ip: z.string().min(1),
  hostname: z.string().optional(),
  mac: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  upstream_ip: z.string().optional(),

  role: z.string().optional(),
  type: z.enum(DEVICE_TYPES).optional(),
  type_label: z.string().optional(),
  avatar: z.string().optional(),
  icon: z.string().optional(),

  ssh: z.boolean().optional(),
  os: z.string().optional(),
  web: z.string().optional(),

  /** Legacy shorthand kept for backwards compatibility:
   *  `integration: openwrt` == `metrics: { type: openwrt }`. */
  integration: z.enum(["openwrt"]).optional(),
  metrics: MetricsSourceSchema.optional(),

  specs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  ports: z.array(z.number().int().min(0).max(65535)).optional(),
  port_map: z.array(PortMapEntrySchema).optional(),
  services: z.array(ServiceSchema).optional(),
  docker: z.array(ContainerSchema).optional(),
  links: z.array(LinkSchema).optional(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const NetworkSchema = z.object({
  subnet: z.string().optional(),
  gateway: z.string().optional(),
  dns: z.string().optional(),
  domain: z.string().optional(),
  upstream_gateway: z.string().optional(),
  upstream_ssid: z.string().optional(),
});
export type Network = z.infer<typeof NetworkSchema>;

export const ConfigSchema = z.object({
  title: z.string().default("Homelab Dashboard"),
  network: NetworkSchema.optional(),
  devices: z.array(DeviceSchema).default([]),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Resolve a device's effective metrics source, applying the
 *  `integration:` shorthand and the ssh/none defaults. */
export function resolveMetricsSource(device: Device): MetricsSource {
  if (device.metrics) return device.metrics;
  if (device.integration === "openwrt") return MetricsSourceSchema.parse({ type: "openwrt" });
  if (device.ssh) return MetricsSourceSchema.parse({ type: "ssh" });
  return { type: "none" };
}
