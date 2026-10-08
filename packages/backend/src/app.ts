/* ============================================================
   app.ts — builds the Fastify instance.

   Separated from index.ts so tests can build an app and drive it
   with app.inject() without binding a port or starting timers.
   ============================================================ */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { env } from "./env.js";
import { configRoutes } from "./routes/config.js";
import { iconRoutes } from "./routes/icons.js";
import { metricsRoutes } from "./routes/metrics.js";
import { routerProxyRoutes } from "./routes/router-proxy.js";
import { streamRoutes } from "./routes/stream.js";

export interface BuildOptions {
  /** Skip serving the Vite build (tests, API-only runs). */
  serveStatic?: boolean;
}

/** Vite emits content-hashed names like `index-BpqXvFEF.js` — an 8-char
 *  base64url hash before the extension. Only those are safe to pin. */
const FINGERPRINTED = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

export function isFingerprinted(path: string): boolean {
  return FINGERPRINTED.test(path);
}

/** True when a URL path names a file (has an extension in its last segment)
 *  rather than a client-side route. `/assets/icon.png` yes; `/topology` no. */
export function looksLikeFile(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  const last = path.split("/").pop() ?? "";
  return /\.[a-zA-Z0-9]{1,8}$/.test(last);
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.logLevel },
    // The dashboard sits behind Nginx Proxy Manager on the LAN.
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(configRoutes);
  await app.register(iconRoutes);
  await app.register(metricsRoutes);
  await app.register(streamRoutes);
  await app.register(routerProxyRoutes);

  app.get("/api/healthz", async () => ({ ok: true, uptime: process.uptime() }));

  const serveStatic = options.serveStatic ?? Boolean(env.staticDir);
  if (serveStatic) {
    // Uploaded icons live outside the Vite build so they survive a rebuild,
    // so they get their own root mounted under the same /assets/icons tree
    // the presets use. Registered before the build's static handler because
    // the more specific prefix must win.
    await mkdir(env.iconDir, { recursive: true }).catch(() => undefined);
    await app.register(fastifyStatic, {
      root: env.iconDir,
      prefix: "/assets/icons/user/",
      // Only one static plugin may decorate reply.sendFile().
      decorateReply: false,
      index: false,
      setHeaders(res) {
        // Names are user-chosen and stable, so a replaced icon must not be
        // pinned in the cache the way a fingerprinted bundle can be.
        res.setHeader("Cache-Control", "public, max-age=60");
        // An uploaded SVG is inert: never sniffed into something else, and
        // unable to fetch or execute anything if opened directly.
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      },
    });
  }

  if (serveStatic && env.staticDir && existsSync(env.staticDir)) {
    await app.register(fastifyStatic, {
      root: env.staticDir,
      index: ["index.html"],
      // index.html must never be cached: it is the only file naming the
      // current bundle, and a stale copy pins the browser to the previous
      // deploy's JS.
      //
      // Only content-hashed files may be immutable. Not everything under
      // /assets/ qualifies: files Vite copies from public/ (the device
      // icons, referenced by stable path from config.yaml) keep their
      // names, so caching those for a year would make replacing an icon
      // invisible until the cache expired.
      setHeaders(res, path) {
        if (path.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache, must-revalidate");
        } else if (isFingerprinted(path)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "public, max-age=300");
        }
      },
    });

    // Single-page app: anything that isn't an API route or a real file
    // falls back to index.html so a deep link can be opened directly.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/router/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      // A request for a missing *file* must 404, not fall through to the SPA.
      // Otherwise a typo'd icon path in config.yaml silently returns
      // index.html with a 200, and the broken <img> is invisible in the
      // network tab. Only extensionless paths are real client-side routes.
      if (looksLikeFile(req.url)) {
        return reply.code(404).send({ error: "Not found" });
      }
      reply.header("Cache-Control", "no-cache, must-revalidate");
      return reply.sendFile("index.html");
    });
  } else if (serveStatic) {
    app.log.warn({ dir: env.staticDir }, "static directory missing — run `pnpm build` in the frontend");
  }

  return app;
}
