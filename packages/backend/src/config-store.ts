/* ============================================================
   config-store.ts — owns config.yaml: load, validate, cache,
   watch for external edits, and write back safely.
   ============================================================ */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import yaml from "js-yaml";
import { ConfigSchema, type Config } from "@homelab/shared";
import { env } from "./env.js";
import { publish } from "./events.js";

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

let cached: Config | null = null;
let watcher: FSWatcher | null = null;
let reloadTimer: NodeJS.Timeout | null = null;

/** Parse + validate YAML text. Throws ConfigError with readable issues. */
export function parseConfig(text: string): Config {
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (err) {
    throw new ConfigError(`Invalid YAML: ${yamlErrorMessage(err)}`);
  }

  const parsed = ConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`,
    );
    throw new ConfigError("Config failed schema validation", issues);
  }
  return parsed.data;
}

/**
 * Condense a js-yaml failure into one readable line.
 *
 * YAMLException.message embeds a multi-line excerpt of the offending
 * source, which is useful in a terminal but turns into an unreadable
 * run-on once it reaches a single-line status pill. Prefer the
 * structured `reason` plus the mark's position.
 */
function yamlErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "reason" in err) {
    const e = err as { reason?: string; mark?: { line?: number; column?: number } };
    const where =
      e.mark?.line !== undefined
        ? ` (line ${e.mark.line + 1}, column ${(e.mark.column ?? 0) + 1})`
        : "";
    return `${e.reason ?? "parse error"}${where}`;
  }
  return err instanceof Error ? err.message.split("\n")[0]! : String(err);
}

export async function loadConfig(force = false): Promise<Config> {
  if (cached && !force) return cached;
  const text = await readFile(env.configPath, "utf8");
  cached = parseConfig(text);
  return cached;
}

export function cachedConfig(): Config | null {
  return cached;
}

/** Raw file contents, for the YAML editor. */
export function readConfigText(): Promise<string> {
  return readFile(env.configPath, "utf8");
}

/**
 * Validate and persist new YAML.
 *
 * Writes a timestamped backup first, then writes to a temp file in the
 * same directory and renames it into place, so a crash mid-write can
 * never leave a truncated config.yaml behind.
 */
export async function saveConfigText(text: string, now = new Date()): Promise<Config> {
  const config = parseConfig(text); // throws before anything is touched

  await mkdir(env.backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const previous = await readFile(env.configPath, "utf8").catch(() => null);
  if (previous !== null) {
    await writeFile(join(env.backupDir, `${basename(env.configPath)}.${stamp}.bak`), previous, "utf8");
  }

  await writeAtomic(env.configPath, text);

  cached = config;
  publish({ type: "config", data: { reason: "saved" } });
  return config;
}

/**
 * Write via a temp file and rename, so a crash mid-write cannot leave a
 * truncated config.yaml behind.
 *
 * Falls back to writing in place when rename is refused. Docker pins an
 * individually bind-mounted file, so renaming over it fails with EBUSY
 * (and across filesystems, EXDEV). Mounting the whole config/ directory
 * avoids this — see docker-compose.yml — but a single-file mount is a
 * reasonable thing for someone to do, and it should still work.
 */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EBUSY" && code !== "EXDEV" && code !== "EPERM") throw err;
    await rm(tmp, { force: true });
    // A backup was already written by the caller, so a failure here is
    // recoverable even though this path is not atomic.
    await writeFile(path, text, "utf8");
  }
}

/**
 * Watch config.yaml for edits made outside the dashboard (an $EDITOR
 * session, a `make deploy` rsync) and hot-reload them.
 *
 * Debounced: editors routinely produce several rename/change events per
 * save, and rsync writes a temp file then renames over the target.
 */
export function watchConfig(onReload: (config: Config) => void): void {
  if (watcher) return;

  // Watch the *directory*, not the file. Editors and `sed -i` write a temp
  // file and rename it over the target, which replaces the inode — a watch
  // on the file itself would keep watching the old, now-unlinked one and
  // never fire again. rsync (as used by `make deploy`) does the same.
  const dir = dirname(env.configPath);
  const target = basename(env.configPath);

  try {
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      // filename is null on some platforms; reload rather than miss a change.
      if (filename && filename.toString() !== target) return;

      // Debounced: one save typically emits several rename/change events,
      // and the file is momentarily absent between them.
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        void loadConfig(true)
          .then((config) => {
            publish({ type: "config", data: { reason: "changed" } });
            onReload(config);
          })
          .catch(() => {
            // A half-written file during a save is expected; the next
            // event brings the complete version.
          });
      }, 250);
      reloadTimer.unref?.();
    });
  } catch {
    // Watching is a convenience — a missing inotify watch must not stop boot.
  }
}

export function stopWatching(): void {
  watcher?.close();
  watcher = null;
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = null;
}
