/* API-surface tests. The app is built without static serving and driven
   with inject(), so nothing binds a port and no collectors run. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { buildApp } from "../src/app.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

let app: Awaited<ReturnType<typeof buildApp>>;
let workDir: string;
let configPath: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "homelab-api-"));
  configPath = join(workDir, "config.yaml");
  await writeFile(configPath, await readFile(join(repoRoot, "config/example-config.yaml"), "utf8"));

  // env.ts snapshots process.env at import time, so these must be set
  // before the module graph is loaded.
  process.env["CONFIG_PATH"] = configPath;
  process.env["CONFIG_BACKUP_DIR"] = join(workDir, "backups");
  process.env["NETMAP_DIR"] = join(workDir, "netmap");
  process.env["LOG_LEVEL"] = "silent";
  process.env["ROUTER_URL"] = "";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ serveStatic: false });
});

afterAll(async () => {
  await app?.close();
});

describe("GET /api/healthz", () => {
  it("reports ok", async () => {
    const res = await app.inject({ method: "GET", url: "/api/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });
});

describe("GET /api/config", () => {
  it("returns the validated config as JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/api/config" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.devices.length).toBeGreaterThan(0);
    expect(body.devices[0]).toHaveProperty("name");
  });

  it("serves the raw YAML for the editor", async () => {
    const res = await app.inject({ method: "GET", url: "/api/config/raw" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("yaml");
    expect(res.body).toContain("devices:");
  });
});

describe("POST /api/config/validate", () => {
  it("accepts valid YAML without writing anything", async () => {
    const before = await readFile(configPath, "utf8");
    const res = await app.inject({
      method: "POST",
      url: "/api/config/validate",
      payload: { yaml: "title: T\ndevices:\n  - name: a\n    ip: 10.0.0.1\n" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, devices: 1 });
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("rejects malformed YAML with a readable message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/config/validate",
      payload: { yaml: "devices:\n  - name: [unclosed\n" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/Invalid YAML/);
  });

  it("rejects schema violations and names the offending path", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/config/validate",
      payload: { yaml: "devices:\n  - ip: 10.0.0.1\n" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toMatch(/schema validation/);
    expect(body.issues.join(" ")).toContain("devices.0.name");
  });

  it("rejects a body that isn't { yaml: string }", async () => {
    const res = await app.inject({ method: "POST", url: "/api/config/validate", payload: { nope: 1 } });
    expect(res.statusCode).toBe(400);
  });
});

describe("PUT /api/config", () => {
  it("writes the new config and backs up the previous one", async () => {
    const yaml = "title: Rewritten\ndevices:\n  - name: solo\n    ip: 10.0.0.9\n";
    const res = await app.inject({ method: "PUT", url: "/api/config", payload: { yaml } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, devices: 1 });

    expect(await readFile(configPath, "utf8")).toBe(yaml);

    const backups = await readdir(join(workDir, "backups"));
    expect(backups.length).toBe(1);
    expect(backups[0]).toMatch(/^config\.yaml\..*\.bak$/);

    // The cache must reflect the write immediately.
    const after = await app.inject({ method: "GET", url: "/api/config" });
    expect(after.json().title).toBe("Rewritten");
  });

  it("leaves the file untouched when validation fails", async () => {
    const before = await readFile(configPath, "utf8");
    const res = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { yaml: "devices:\n  - ip: 1.2.3.4\n" },
    });
    expect(res.statusCode).toBe(422);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });
});

describe("metrics endpoints", () => {
  it("returns an empty snapshot when no collector has run", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("404s for a device with no metrics", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("returns history keyed by device", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/history" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  it("returns an empty sample list for one device", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/history?device=x&window=60" });
    expect(res.json()).toEqual({ device: "x", samples: [] });
  });

  it("rejects a negative window", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics/history?window=-5" });
    expect(res.statusCode).toBe(400);
  });
});

describe("topology endpoints", () => {
  it("reports no graph before the sidecar has scanned", async () => {
    const res = await app.inject({ method: "GET", url: "/api/topology" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ graph: null, scannedAt: null });
  });

  it("serves a graph the sidecar wrote", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(workDir, "netmap"), { recursive: true });
    await writeFile(
      join(workDir, "netmap", "graph.json"),
      await readFile(join(repoRoot, "packages/shared/test/fixtures/netmap-graph.json"), "utf8"),
    );

    const res = await app.inject({ method: "GET", url: "/api/topology" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.graph.gateway).toBe("10.20.0.1");
    expect(body.scannedAt).toBeGreaterThan(0);
  });

  it("accepts a scan request by touching the trigger file", async () => {
    const res = await app.inject({ method: "POST", url: "/api/topology/scan" });
    expect(res.statusCode).toBe(200);
    expect(await readdir(join(workDir, "netmap"))).toContain(".scan-now");
  });
});

describe("not-found handling", () => {
  it("404s unknown API routes as JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(res.statusCode).toBe(404);
  });

  it("disables the router proxy when ROUTER_URL is unset", async () => {
    const res = await app.inject({ method: "GET", url: "/router/ubus" });
    expect(res.statusCode).toBe(404);
  });
});

describe("YAML error reporting", () => {
  it("condenses a parse failure to one line with a position", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/config/validate",
      payload: { yaml: "title: T\nbroken: [unclosed\ndevices: []\n" },
    });
    expect(res.statusCode).toBe(422);
    const { error } = res.json();
    // The raw js-yaml message embeds a multi-line source excerpt; the API
    // must not leak that into a single-line status pill.
    expect(error).not.toContain("\n");
    expect(error).toMatch(/^Invalid YAML: /);
    expect(error).toMatch(/line \d+, column \d+/);
    expect(error.length).toBeLessThan(120);
  });
});


describe("isFingerprinted", () => {
  it("recognises Vite's content-hashed output", async () => {
    const { isFingerprinted } = await import("../src/app.js");
    for (const name of [
      "/dist/assets/index-BpqXvFEF.js",
      "/dist/assets/index-BpqXvFEF.css",
      "/dist/assets/inter-latin-400-normal-C38fXH4l.woff2",
    ]) {
      expect(isFingerprinted(name)).toBe(true);
    }
  });

  it("does not treat stable public/ filenames as immutable", async () => {
    const { isFingerprinted } = await import("../src/app.js");
    // These are copied verbatim from public/ and referenced by stable path
    // from config.yaml — pinning them for a year would make replacing an
    // icon invisible to browsers.
    for (const name of [
      "/dist/assets/yaml.svg",
      "/dist/assets/icons/router.svg",
      "/dist/assets/icons/server-tower.svg",
      "/dist/index.html",
    ]) {
      expect(isFingerprinted(name)).toBe(false);
    }
  });

  it("is not fooled by a hyphenated name of the same length", async () => {
    const { isFingerprinted } = await import("../src/app.js");
    expect(isFingerprinted("/dist/assets/my-icon.png")).toBe(false);
    expect(isFingerprinted("/dist/assets/some-longer-name.svg")).toBe(false);
  });
});

describe("looksLikeFile", () => {
  it("treats paths with a file extension as files", async () => {
    const { looksLikeFile } = await import("../src/app.js");
    for (const url of [
      "/assets/my-logo.svg",
      "/assets/icon.png",
      "/favicon.ico",
      "/assets/index-BpqXvFEF.js",
      "/assets/style.css?v=2",
    ]) {
      expect(looksLikeFile(url)).toBe(true);
    }
  });

  it("treats client-side routes as routes, not files", async () => {
    const { looksLikeFile } = await import("../src/app.js");
    // These must still fall through to index.html so deep links work.
    for (const url of [
      "/",
      "/topology",
      "/dashboard/device/atlas",
      "/services?filter=jellyfin",
      "/some.dotted/path",
    ]) {
      expect(looksLikeFile(url)).toBe(false);
    }
  });
});
