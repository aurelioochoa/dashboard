/* ============================================================
   topology.ts — reads the graph the netmap sidecar produces.

   netmap needs NET_RAW/NET_ADMIN and the host network namespace
   to run arp-scan/nmap/traceroute. The backend deliberately has
   none of that, so the two never share a process: the sidecar
   writes /data/netmap/graph.json, and this module only reads it.

   On-demand scans are requested by touching a trigger file the
   sidecar's loop watches — a shared volume, not a socket, so
   neither container needs to reach the other.
   ============================================================ */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { HostGraphSchema, type TopologySnapshot } from "@homelab/shared";
import type { FastifyBaseLogger } from "fastify";
import { env } from "./env.js";
import { publish } from "./events.js";

export const GRAPH_FILE = "graph.json";
export const TRIGGER_FILE = ".scan-now";
/** Written by the sidecar while a scan is in progress. */
export const LOCK_FILE = ".scanning";

let snapshot: TopologySnapshot = { graph: null, scannedAt: null, scanning: false };
let watcher: FSWatcher | null = null;
let debounce: NodeJS.Timeout | null = null;

export function latestTopology(): TopologySnapshot {
  return snapshot;
}

export async function readGraph(log?: FastifyBaseLogger): Promise<TopologySnapshot> {
  const path = join(env.netmapDir, GRAPH_FILE);

  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const parsed = HostGraphSchema.safeParse(JSON.parse(text));

    if (!parsed.success) {
      const error = `graph.json failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`;
      log?.warn({ path }, error);
      return { ...snapshot, error };
    }

    return {
      graph: parsed.data,
      scannedAt: info.mtimeMs,
      scanning: await isScanning(),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Expected before the sidecar's first scan completes.
      return { graph: null, scannedAt: null, scanning: await isScanning() };
    }
    return {
      ...snapshot,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function isScanning(): Promise<boolean> {
  try {
    await stat(join(env.netmapDir, LOCK_FILE));
    return true;
  } catch {
    return false;
  }
}

/** Ask the sidecar to scan now by touching the trigger file. */
export async function requestScan(): Promise<{ ok: boolean; error?: string }> {
  try {
    await mkdir(env.netmapDir, { recursive: true });
    await writeFile(join(env.netmapDir, TRIGGER_FILE), String(Date.now()), "utf8");
    snapshot = { ...snapshot, scanning: true };
    publish({ type: "topology", data: snapshot });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Watch the shared volume and broadcast whenever the graph changes. */
export function watchTopology(log: FastifyBaseLogger): void {
  void refresh(log);

  try {
    watcher = watch(env.netmapDir, { persistent: false }, (_event, filename) => {
      const name = filename?.toString();
      // Watch the lock file too, so "scanning" clears as soon as the
      // sidecar finishes rather than at the next poll.
      if (name && name !== GRAPH_FILE && name !== LOCK_FILE) return;

      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(log), 300);
      debounce.unref?.();
    });
  } catch {
    // The directory may not exist when the sidecar is not deployed.
    log.info({ dir: env.netmapDir }, "netmap directory not watchable — topology disabled");
  }
}

async function refresh(log: FastifyBaseLogger): Promise<void> {
  const next = await readGraph(log);
  const changed =
    next.scannedAt !== snapshot.scannedAt ||
    next.scanning !== snapshot.scanning ||
    next.error !== snapshot.error;

  snapshot = next;
  if (changed) publish({ type: "topology", data: snapshot });
}

export function stopWatchingTopology(): void {
  watcher?.close();
  watcher = null;
  if (debounce) clearTimeout(debounce);
  debounce = null;
}
