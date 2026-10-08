import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";
import { ConfigSchema } from "@homelab/shared";
import { buildIndex, search } from "../src/search.js";

const here = dirname(fileURLToPath(import.meta.url));
const config = ConfigSchema.parse(
  yaml.load(readFileSync(resolve(here, "../../../config/example-config.yaml"), "utf8")),
);
const index = buildIndex(config);

const titles = (q: string, n = 5): string[] =>
  search(index, q, n).map((m) => m.entry.title);

describe("buildIndex", () => {
  it("indexes every device plus its services, ports, containers and links", () => {
    const kinds = new Set(index.map((e) => e.kind));
    expect(kinds).toContain("device");
    expect(kinds).toContain("service");
    expect(kinds).toContain("port");
    expect(kinds).toContain("container");
    expect(kinds).toContain("link");
    expect(kinds).toContain("tab");
    expect(index.filter((e) => e.kind === "device").length).toBe(config.devices.length);
  });

  it("gives every entry a unique id", () => {
    expect(new Set(index.map((e) => e.id)).size).toBe(index.length);
  });
});

describe("search ranking", () => {
  it("puts an exact device name first", () => {
    expect(titles("atlas")[0]).toBe("atlas");
    expect(titles("vault")[0]).toBe("vault");
  });

  it("finds a container by name", () => {
    expect(titles("jellyfin").join(" ")).toContain("jellyfin");
  });

  it("finds a service running on a device", () => {
    expect(titles("dnsmasq", 8).join(" ")).toContain("dnsmasq");
  });

  it("ranks a prefix match above a mid-string one", () => {
    const results = search(index, "pi", 10);
    expect(results[0]?.entry.title.toLowerCase().startsWith("pi")).toBe(true);
  });

  it("matches a scattered subsequence", () => {
    // "pnd" hits p, n, d of "pi-node" in order.
    expect(titles("pnd").join(" ").toLowerCase()).toContain("pi-node");
  });

  it("searches hidden fields like MAC addresses", () => {
    const results = search(index, "02:00:5e:10:00:0a", 5);
    expect(results.some((r) => r.entry.device === "atlas")).toBe(true);
  });

  it("finds a port number", () => {
    expect(search(index, "8096", 5).some((r) => r.entry.kind === "port")).toBe(true);
  });

  it("returns navigation entries for an empty query", () => {
    const results = search(index, "");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => ["tab", "device", "action"].includes(r.entry.kind))).toBe(true);
  });

  it("returns nothing for gibberish", () => {
    expect(search(index, "zzzqqqxxx")).toEqual([]);
  });

  it("respects the result limit", () => {
    expect(search(index, "a", 3).length).toBeLessThanOrEqual(3);
  });

  it("reports ranges that actually cover the query", () => {
    const [match] = search(index, "atl", 1);
    expect(match).toBeDefined();
    const covered = match!.ranges
      .map(([s, e]) => match!.entry.title.slice(s, e))
      .join("")
      .toLowerCase();
    expect(covered).toBe("atl");
  });

  it("is case-insensitive", () => {
    expect(titles("ATLAS")[0]).toBe("atlas");
  });
});
