import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** Where `pnpm dev` proxies API calls. The backend runs standalone in dev;
 *  in production Fastify serves this build itself, so everything is
 *  same-origin and no proxy is involved. */
const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its TypeScript source. Its
      // package.json exports point at dist/ (which is what Node needs at
      // runtime); aliasing here means editing shared/ hot-reloads without
      // a separate build step.
      "@homelab/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/router": { target: BACKEND, changeOrigin: true },
    },
  },
});
