import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";
import { ConfigSchema, resolveMetricsSource, DeviceSchema } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

function loadYaml(relPath: string): unknown {
  return yaml.load(readFileSync(resolve(repoRoot, relPath), "utf8"));
}

describe("ConfigSchema", () => {
  // config/config.yaml is the deployer's own, git-ignored file; a fresh
  // clone doesn't have one.
  it.skipIf(!existsSync(resolve(repoRoot, "config/config.yaml")))("accepts the real config.yaml unchanged", () => {
    const parsed = ConfigSchema.safeParse(loadYaml("config/config.yaml"));
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    expect(parsed.data.devices.length).toBeGreaterThan(0);
    expect(parsed.data.network?.subnet).toBeDefined();
  });

  it("accepts the shipped example config", () => {
    const parsed = ConfigSchema.safeParse(loadYaml("config/example-config.yaml"));
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2));
  });

  it("defaults title and devices when absent", () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed.title).toBe("Homelab Dashboard");
    expect(parsed.devices).toEqual([]);
  });

  it("rejects a device without a name", () => {
    expect(ConfigSchema.safeParse({ devices: [{ ip: "10.0.0.1" }] }).success).toBe(false);
  });

  it("rejects an out-of-range port", () => {
    expect(DeviceSchema.safeParse({ name: "x", ip: "10.0.0.1", ports: [70000] }).success).toBe(false);
  });
});

describe("resolveMetricsSource", () => {
  it("maps the legacy integration shorthand to an openwrt source", () => {
    const src = resolveMetricsSource({ name: "r", ip: "10.0.0.1", integration: "openwrt" });
    expect(src.type).toBe("openwrt");
    if (src.type === "openwrt") expect(src.interval).toBe(5);
  });

  it("defaults to ssh when the device advertises ssh", () => {
    const src = resolveMetricsSource({ name: "s", ip: "10.0.0.2", ssh: true });
    expect(src.type).toBe("ssh");
    if (src.type === "ssh") {
      expect(src.port).toBe(22);
      expect(src.user).toBe("root");
    }
  });

  it("prefers an explicit metrics block over the shorthand", () => {
    const src = resolveMetricsSource({
      name: "s",
      ip: "10.0.0.3",
      ssh: true,
      integration: "openwrt",
      metrics: { type: "exporter", url: "http://10.0.0.3:9100/metrics", interval: 10 },
    });
    expect(src.type).toBe("exporter");
  });

  it("returns none for a device with no reachable source", () => {
    expect(resolveMetricsSource({ name: "d", ip: "10.0.0.4" }).type).toBe("none");
  });
});
