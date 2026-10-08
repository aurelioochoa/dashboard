/* ============================================================
   routes/router-proxy.ts — same-origin proxy to the OpenWrt
   router, replacing the old nginx `location /router/` block.

   Kept because LuCI is worth reaching from the dashboard origin,
   and because it lets a browser talk ubus without the router
   needing CORS headers. Metrics no longer go through here — the
   openwrt collector calls ubus server-side.
   ============================================================ */

import type { FastifyInstance } from "fastify";
import { request } from "undici";
import { env } from "./../env.js";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

export async function routerProxyRoutes(app: FastifyInstance): Promise<void> {
  if (!env.routerUrl) {
    app.log.info("ROUTER_URL unset — /router proxy disabled");
    return;
  }

  const upstream = env.routerUrl.replace(/\/+$/, "");

  app.all("/router/*", async (req, reply) => {
    const suffix = (req.params as Record<string, string>)["*"] ?? "";
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const target = `${upstream}/${suffix}${query}`;

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
    }

    try {
      const res = await request(target, {
        method: req.method as "GET",
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : (req.body as string),
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });

      for (const [k, v] of Object.entries(res.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) {
          reply.header(k, v as string | string[]);
        }
      }
      return reply.code(res.statusCode).send(res.body);
    } catch (err) {
      req.log.warn({ err, target }, "router proxy failed");
      return reply.code(502).send({ error: "Router unreachable" });
    }
  });
}
