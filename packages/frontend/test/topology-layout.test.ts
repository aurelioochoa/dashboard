import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";
import { ConfigSchema, HostGraphSchema, type Config } from "@homelab/shared";
import { buildLayout, matchDevice, neighboursOf } from "../src/topology-layout.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

const config: Config = ConfigSchema.parse(
  yaml.load(readFileSync(resolve(root, "config/example-config.yaml"), "utf8")),
);
const graph = HostGraphSchema.parse(
  JSON.parse(readFileSync(resolve(root, "packages/shared/test/fixtures/netmap-graph.json"), "utf8")),
);

describe("matchDevice", () => {
  it("matches on MAC regardless of case or separators", () => {
    const host = { ip: "10.9.9.9", mac: "02-00-5E-10-00-1E", open_ports: [], role: "Unknown" as const, detected_by: [] };
    expect(matchDevice(host, config.devices)?.name).toBe("pi-node");
  });

  it("falls back to IP when there is no MAC", () => {
    const host = { ip: "10.20.0.10", open_ports: [], role: "Unknown" as const, detected_by: [] };
    expect(matchDevice(host, config.devices)?.name).toBe("atlas");
  });

  it("matches the router on its upstream address too", () => {
    const host = { ip: "10.0.0.2", open_ports: [], role: "Gateway" as const, detected_by: [] };
    expect(matchDevice(host, config.devices)?.name).toBe("gateway");
  });

  it("returns undefined for a host that isn't configured", () => {
    const host = { ip: "10.20.0.200", open_ports: [], role: "Unknown" as const, detected_by: [] };
    expect(matchDevice(host, config.devices)).toBeUndefined();
  });

  it("prefers a MAC match over an IP match (device moved by DHCP)", () => {
    const host = {
      ip: "10.20.0.10", // atlas's IP
      mac: "02:00:5e:10:00:1e", // but pi-node's MAC
      open_ports: [], role: "Unknown" as const, detected_by: [],
    };
    expect(matchDevice(host, config.devices)?.name).toBe("pi-node");
  });
});

describe("buildLayout", () => {
  const layout = buildLayout(graph, config);

  it("produces a node per discovered host", () => {
    expect(layout.nodes.length).toBe(Object.keys(graph.hosts).length);
  });

  it("puts the gateway on tier 0 and the rest below it", () => {
    const gw = layout.nodes.find((n) => n.ip === graph.gateway)!;
    expect(gw.tier).toBe(0);
    for (const node of layout.nodes) {
      if (node.ip !== graph.gateway) expect(node.tier).toBeGreaterThan(0);
    }
  });

  it("labels matched hosts with their configured name", () => {
    const pi = layout.nodes.find((n) => n.ip === "10.20.0.30")!;
    expect(pi.known).toBe(true);
    expect(pi.label).toBe("pi-node");
  });

  it("marks unmatched hosts as unknown and falls back to the IP", () => {
    const extended = {
      ...graph,
      hosts: { ...graph.hosts, "10.20.0.77": { ip: "10.20.0.77", open_ports: [], role: "Unknown" as const, detected_by: [] } },
    };
    const node = buildLayout(extended, config).nodes.find((n) => n.ip === "10.20.0.77")!;
    expect(node.known).toBe(false);
    expect(node.label).toBe("10.20.0.77");
  });

  it("assigns non-overlapping positions within a tier", () => {
    const byTier = new Map<number, typeof layout.nodes>();
    for (const n of layout.nodes) byTier.set(n.tier, [...(byTier.get(n.tier) ?? []), n]);
    for (const list of byTier.values()) {
      const sorted = [...list].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]!.x).toBeGreaterThanOrEqual(sorted[i - 1]!.x + sorted[i - 1]!.width);
      }
    }
  });

  it("gives every tier a distinct y and keeps them ordered", () => {
    const ys = layout.tiers.map((t) => t.y);
    expect(new Set(ys).size).toBe(ys.length);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it("draws each edge once even if netmap reports both directions", () => {
    const doubled = {
      ...graph,
      edges: [...graph.edges, ...graph.edges.map((e) => ({ from: e.to, to: e.from, hop_index: e.hop_index }))],
    };
    expect(buildLayout(doubled, config).edges.length).toBe(graph.edges.length);
  });

  it("drops edges pointing at hosts absent from the graph", () => {
    const dangling = { ...graph, edges: [...graph.edges, { from: "10.20.0.1", to: "10.0.0.254", hop_index: 1 }] };
    expect(buildLayout(dangling, config).edges.length).toBe(graph.edges.length);
  });

  it("handles an empty graph without throwing", () => {
    const empty = buildLayout({ hosts: {}, edges: [], gateway: null }, config);
    expect(empty.nodes).toEqual([]);
    expect(empty.width).toBeGreaterThan(0);
  });

  it("sizes the canvas to fit every node", () => {
    for (const node of layout.nodes) {
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
    }
  });
});

describe("neighboursOf", () => {
  it("includes the node itself and everything it connects to", () => {
    const layout = buildLayout(graph, config);
    const set = neighboursOf(layout, "10.20.0.1");
    expect(set.has("10.20.0.1")).toBe(true);
    expect(set.has("10.20.0.30")).toBe(true);
  });

  it("returns just the node when it has no edges", () => {
    const layout = buildLayout({ ...graph, edges: [] }, config);
    expect([...neighboursOf(layout, "10.20.0.1")]).toEqual(["10.20.0.1"]);
  });
});
