import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { HostGraphSchema, ROLE_ACCENT } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "fixtures/netmap-graph.json"), "utf8"),
);

describe("HostGraphSchema", () => {
  it("parses a real `netmap scan --output` capture", () => {
    const parsed = HostGraphSchema.safeParse(fixture);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    expect(parsed.data.gateway).toBe("10.20.0.1");
    expect(Object.keys(parsed.data.hosts).length).toBeGreaterThan(0);
    expect(parsed.data.hosts["10.20.0.1"]?.role).toBe("Gateway");
  });

  it("tolerates a role emitted by a newer netmap", () => {
    const graph = HostGraphSchema.parse({
      hosts: { "10.0.0.1": { ip: "10.0.0.1", role: "SomethingNew" } },
      edges: [],
      gateway: null,
    });
    expect(graph.hosts["10.0.0.1"]?.role).toBe("Unknown");
  });

  it("defaults absent collections", () => {
    const graph = HostGraphSchema.parse({ hosts: {} });
    expect(graph.edges).toEqual([]);
  });

  it("has an accent for every role", () => {
    for (const role of Object.keys(ROLE_ACCENT)) {
      expect(ROLE_ACCENT[role as keyof typeof ROLE_ACCENT]).toMatch(/^var\(--/);
    }
  });
});
