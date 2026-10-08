/* ============================================================
   routes/metrics.ts — metric snapshots, history, health, topology.
   ============================================================ */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadConfig } from "../config-store.js";
import { probeNow, latestHealth } from "../health.js";
import { allHistory, historyFor, latestMetrics, metricsFor } from "../metrics-store.js";
import { latestTopology, readGraph, requestScan } from "../topology.js";

const HistoryQuerySchema = z.object({
  device: z.string().optional(),
  window: z.coerce.number().int().positive().optional(),
});

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/metrics", async () => latestMetrics());

  app.get("/api/metrics/history", async (req, reply) => {
    const query = HistoryQuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Invalid query — expected ?device=&window=<seconds>" });
    }
    const { device, window } = query.data;
    if (device) return { device, samples: historyFor(device, window) };
    return allHistory(window);
  });

  app.get("/api/metrics/:device", async (req, reply) => {
    const { device } = req.params as { device: string };
    const metrics = metricsFor(device);
    if (!metrics) return reply.code(404).send({ error: `No metrics for ${device}` });
    return metrics;
  });

  app.get("/api/health", async () => latestHealth());

  app.post("/api/health/check", async () => probeNow(await loadConfig()));

  app.get("/api/topology", async () => {
    const current = latestTopology();
    // Read through on a cold start so the first request isn't empty just
    // because the watcher hasn't fired yet.
    return current.graph ? current : readGraph(app.log);
  });

  app.post("/api/topology/scan", async (_req, reply) => {
    const result = await requestScan();
    if (!result.ok) return reply.code(503).send({ error: result.error });
    return { ok: true };
  });
}
