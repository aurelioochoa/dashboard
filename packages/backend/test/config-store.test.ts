/* Covers the write path in isolation, including the Docker case where the
   destination file is pinned by a single-file bind mount and rename fails. */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
// Type-only imports: erased at compile time, so they do not pull the
// modules in ahead of the env-var setup / vi.mock these tests rely on.
import type * as FsPromises from "node:fs/promises";
import type * as ConfigStore from "../src/config-store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Set by individual tests to make rename fail with a given errno. */
let renameFailure: string | null = null;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (renameFailure) {
        const err = new Error(`${renameFailure}: simulated`) as NodeJS.ErrnoException;
        err.code = renameFailure;
        throw err;
      }
      return actual.rename(from, to);
    },
  };
});

let workDir: string;
let configPath: string;
let store: typeof ConfigStore;

const VALID = "title: T\ndevices:\n  - name: a\n    ip: 10.0.0.1\n";

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "homelab-store-"));
  configPath = join(workDir, "config.yaml");
  process.env["CONFIG_PATH"] = configPath;
  process.env["CONFIG_BACKUP_DIR"] = join(workDir, "backups");
  process.env["LOG_LEVEL"] = "silent";
  store = await import("../src/config-store.js");
});

afterAll(() => {
  store.stopWatching();
});

beforeEach(async () => {
  renameFailure = null;
  await writeFile(configPath, VALID);
});

describe("parseConfig", () => {
  it("reports a YAML syntax error on one line with a position", () => {
    try {
      store.parseConfig("title: T\nbroken: [unclosed\n");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(store.ConfigError);
      const message = (err as Error).message;
      expect(message).not.toContain("\n");
      expect(message).toMatch(/line \d+, column \d+/);
    }
  });

  it("lists the offending path for a schema violation", () => {
    try {
      store.parseConfig("devices:\n  - ip: 10.0.0.1\n");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as InstanceType<typeof store.ConfigError>).issues[0]).toContain("devices.0.name");
    }
  });

  it("treats an empty document as an empty config", () => {
    expect(store.parseConfig("").devices).toEqual([]);
  });
});

describe("saveConfigText", () => {
  it("writes the file and a timestamped backup", async () => {
    const next = "title: Next\ndevices: []\n";
    await store.saveConfigText(next);
    expect(await readFile(configPath, "utf8")).toBe(next);
    const backups = await readdir(join(workDir, "backups"));
    expect(backups.some((f) => f.startsWith("config.yaml."))).toBe(true);
  });

  it("rejects invalid YAML before touching the file", async () => {
    await expect(store.saveConfigText("devices:\n  - ip: 1.2.3.4\n")).rejects.toThrow(
      store.ConfigError,
    );
    expect(await readFile(configPath, "utf8")).toBe(VALID);
  });

  it.each(["EBUSY", "EXDEV", "EPERM"])(
    "falls back to an in-place write when rename fails with %s",
    async (code) => {
      // Docker pins an individually bind-mounted file, so renaming over it
      // is refused. The save must still succeed.
      renameFailure = code;
      const next = `title: Pinned-${code}\ndevices: []\n`;
      await store.saveConfigText(next);

      expect(await readFile(configPath, "utf8")).toBe(next);
      // No temp file left behind.
      await expect(readFile(`${configPath}.tmp`, "utf8")).rejects.toThrow();
    },
  );

  it("propagates an unexpected rename failure rather than silently writing", async () => {
    renameFailure = "EIO";
    await expect(store.saveConfigText("title: Nope\ndevices: []\n")).rejects.toThrow(/EIO/);
  });
});

describe("watchConfig", () => {
  it("reloads after an editor-style write that replaces the inode", async () => {
    // vim, `sed -i` and rsync all write a temp file and rename it over the
    // target. A watch on the file itself would be left on the old inode.
    const reloads: string[] = [];
    store.watchConfig((config) => reloads.push(config.title));

    try {
      const replaced = "title: ReplacedInode\ndevices: []\n";
      const tmp = `${configPath}.editor-tmp`;
      await writeFile(tmp, replaced);
      const { rename: realRename } = await vi.importActual<typeof FsPromises>("node:fs/promises");
      await realRename(tmp, configPath);

      await vi.waitFor(() => expect(reloads).toContain("ReplacedInode"), {
        timeout: 4000,
        interval: 100,
      });
      expect((await store.loadConfig()).title).toBe("ReplacedInode");
    } finally {
      store.stopWatching();
    }
  });
});
