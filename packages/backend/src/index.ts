/* ============================================================
   index.ts — process entry point.

   Boots the HTTP server, then starts the background workers:
   metric collection, health probes, and the netmap watcher. A
   config.yaml change restarts collection against the new device
   list without a process restart.
   ============================================================ */

import { buildApp } from "./app.js";
import { CollectorRegistry } from "./collectors/index.js";
import { cachedConfig, loadConfig, watchConfig } from "./config-store.js";
import { env } from "./env.js";
import { startHealthChecks, stopHealthChecks } from "./health.js";
import { stopWatchingTopology, watchTopology } from "./topology.js";

async function main(): Promise<void> {
  const app = await buildApp();

  // Fail fast and loudly: a dashboard with an unreadable config is not
  // worth starting, and the error is almost always a bad mount path.
  const config = await loadConfig().catch((err: unknown) => {
    app.log.error({ err, path: env.configPath }, "could not load config.yaml");
    process.exit(1);
  });

  const collectors = new CollectorRegistry(app.log);
  collectors.start(config);
  startHealthChecks(cachedConfig);
  watchTopology(app.log);

  watchConfig((next) => {
    app.log.info("config.yaml changed — restarting collectors");
    collectors.start(next);
  });

  await app.listen({ host: env.host, port: env.port });
  app.log.info(
    { devices: config.devices.length, static: env.staticDir, netmap: env.netmapDir },
    "homelab dashboard ready",
  );

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, "shutting down");
    collectors.dispose();
    stopHealthChecks();
    stopWatchingTopology();
    void app.close().then(() => process.exit(0));
    // Don't hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
