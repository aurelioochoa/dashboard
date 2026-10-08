# ============================================================
# Homelab Dashboard — single image serving the API and the UI.
#
# nginx is gone: Fastify serves the Vite build and owns the
# /router proxy, so there is one process and one origin.
# ============================================================

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ─── Dependencies ───
# Copied separately from the sources so a code change doesn't
# invalidate the (slow) install layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN pnpm install --frozen-lockfile

# ─── Build ───
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
RUN pnpm --filter @homelab/shared build \
 && pnpm --filter @homelab/frontend build \
 && pnpm --filter @homelab/backend build

# ─── Runtime ───
FROM base AS runtime
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
# --prod + the backend's dependency closure only. The pnpm store is
# pruned in the same layer so it never reaches the final image; this
# deploys to an SBC with a 115 GB microSD.
RUN pnpm install --frozen-lockfile --prod --filter @homelab/backend... \
 && pnpm store prune \
 && rm -rf /root/.cache /root/.local/share/pnpm/store

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/backend/dist packages/backend/dist
COPY --from=build /app/packages/frontend/dist packages/frontend/dist

ENV HOST=0.0.0.0 \
    PORT=3000 \
    CONFIG_PATH=/app/config/config.yaml \
    CONFIG_BACKUP_DIR=/app/config/backups \
    STATIC_DIR=/app/packages/frontend/dist \
    NETMAP_DIR=/data/netmap

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/backend/dist/index.js"]
