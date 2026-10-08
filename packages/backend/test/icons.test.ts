/* Icon upload/list/delete, driven through inject() like api.test.ts.
   ICON_DIR points at a temp directory so nothing touches config/icons. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { buildApp } from "../src/app.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

let app: Awaited<ReturnType<typeof buildApp>>;
let iconDir: string;

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const upload = (body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/icons", payload: body });

beforeAll(async () => {
  const workDir = await mkdtemp(join(tmpdir(), "homelab-icons-"));
  iconDir = join(workDir, "icons");
  const configPath = join(workDir, "config.yaml");
  await writeFile(configPath, await readFile(join(repoRoot, "config/example-config.yaml"), "utf8"));

  process.env["CONFIG_PATH"] = configPath;
  process.env["CONFIG_BACKUP_DIR"] = join(workDir, "backups");
  process.env["NETMAP_DIR"] = join(workDir, "netmap");
  process.env["ICON_DIR"] = iconDir;
  process.env["LOG_LEVEL"] = "silent";
  process.env["ROUTER_URL"] = "";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ serveStatic: false });
});

afterAll(async () => {
  await app?.close();
});

describe("GET /api/icons", () => {
  it("lists the presets with their paths", async () => {
    const res = await app.inject({ method: "GET", url: "/api/icons" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { presets: { id: string; path: string }[]; user: unknown[] };
    expect(body.presets.length).toBe(30);
    expect(body.presets.find((p) => p.id === "nas")?.path).toBe("assets/icons/nas.svg");
    expect(body.user).toEqual([]);
  });
});

describe("POST /api/icons", () => {
  it("stores a PNG and lists it back", async () => {
    const res = await upload({
      name: "My Router!.png",
      mime: "image/png",
      data: PNG_1PX.toString("base64"),
    });
    expect(res.statusCode).toBe(200);
    // The display name is slugified; the extension comes from the mime type.
    expect(res.json()).toMatchObject({
      name: "my-router.png",
      path: "assets/icons/user/my-router.png",
    });
    expect(await readdir(iconDir)).toContain("my-router.png");

    const list = await app.inject({ method: "GET", url: "/api/icons" });
    expect((list.json() as { user: { name: string }[] }).user.map((i) => i.name))
      .toContain("my-router.png");
  });

  it("stores a plain SVG", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    const res = await upload({
      name: "logo",
      mime: "image/svg+xml",
      data: Buffer.from(svg).toString("base64"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "logo.svg" });
  });

  it("rejects an SVG carrying script", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/config")</script></svg>';
    const res = await upload({
      name: "evil",
      mime: "image/svg+xml",
      data: Buffer.from(svg).toString("base64"),
    });
    expect(res.statusCode).toBe(422);
    expect(await readdir(iconDir)).not.toContain("evil.svg");
  });

  it("rejects an SVG with an inline event handler", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>';
    const res = await upload({
      name: "onload",
      mime: "image/svg+xml",
      data: Buffer.from(svg).toString("base64"),
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects content that does not match its declared type", async () => {
    const res = await upload({
      name: "fake",
      mime: "image/png",
      data: Buffer.from("MZ this is not a png").toString("base64"),
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects an unsupported type", async () => {
    const res = await upload({
      name: "doc",
      mime: "application/pdf",
      data: Buffer.from("%PDF-1.4").toString("base64"),
    });
    expect(res.statusCode).toBe(415);
  });

  it("rejects a file over the size limit", async () => {
    const res = await upload({
      name: "huge",
      mime: "image/png",
      data: Buffer.concat([PNG_1PX, Buffer.alloc(600 * 1024)]).toString("base64"),
    });
    expect(res.statusCode).toBe(413);
  });

  it("cannot escape the icon directory through the name", async () => {
    const res = await upload({
      name: "../../../../etc/passwd.png",
      mime: "image/png",
      data: PNG_1PX.toString("base64"),
    });
    expect(res.statusCode).toBe(200);
    // Every separator and dot segment is gone: it lands inside iconDir.
    expect(res.json()).toMatchObject({ name: "etc-passwd.png" });
    expect(await readdir(iconDir)).toContain("etc-passwd.png");
  });

  it("rejects a name with nothing usable in it", async () => {
    const res = await upload({ name: "///", mime: "image/png", data: PNG_1PX.toString("base64") });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/icons/:name", () => {
  it("removes an uploaded icon", async () => {
    await upload({ name: "temp", mime: "image/png", data: PNG_1PX.toString("base64") });
    expect(await readdir(iconDir)).toContain("temp.png");

    const res = await app.inject({ method: "DELETE", url: "/api/icons/temp.png" });
    expect(res.statusCode).toBe(200);
    expect(await readdir(iconDir)).not.toContain("temp.png");
  });

  it("404s for something that was never uploaded", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/icons/nope.png" });
    expect(res.statusCode).toBe(404);
  });
});
