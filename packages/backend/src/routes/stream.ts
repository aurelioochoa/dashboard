/* ============================================================
   routes/stream.ts — Server-Sent Events.

   One-directional push is all the dashboard needs, and EventSource
   reconnects on its own. Chosen over WebSockets so it survives the
   LAN's Nginx Proxy Manager without per-host websocket config.
   ============================================================ */

import type { FastifyInstance } from "fastify";
import { subscribe, type DashboardEvent } from "../events.js";
import { latestHealth } from "../health.js";
import { latestMetrics } from "../metrics-store.js";
import { latestTopology } from "../topology.js";

/** Idle keepalive. Must stay below the 60s proxy read timeouts that
 *  otherwise silently drop an idle SSE connection. */
const HEARTBEAT_MS = 25_000;

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/stream", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Belt and braces for any buffering proxy in front of us.
      "X-Accel-Buffering": "no",
    });

    const send = (event: DashboardEvent): void => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    };

    // Replay current state so a fresh tab paints immediately instead of
    // waiting a full poll interval for the next tick.
    for (const m of latestMetrics()) send({ type: "metrics", data: m });
    const health = latestHealth();
    if (health.length) send({ type: "health", data: health });
    send({ type: "topology", data: latestTopology() });

    const unsubscribe = subscribe(send);
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": ping\n\n");
    }, HEARTBEAT_MS);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
  });
}
