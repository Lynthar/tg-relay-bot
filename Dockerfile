# syntax=docker/dockerfile:1.7

# ─── Builder stage ───────────────────────────────────────────────────────────
# Full Debian image so the native better-sqlite3 binding can fall back to
# building from source if a prebuilt binary isn't available for the platform.
FROM node:20-bookworm AS builder
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# npm install, not npm ci: the lockfile records rolldown's optional wasm deps
# inconsistently across OS/npm versions, so the strict sync check fails here
# (same issue and same resolution as in CI).
RUN npm install --omit=dev


# ─── Runner stage ────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

RUN addgroup --system --gid 10001 app \
 && adduser  --system --uid 10001 --gid 10001 \
             --no-create-home --disabled-password app \
 && mkdir -p /data \
 && chown -R app:app /data

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app src          ./src
COPY --chown=app:app package.json ./

USER app
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/server.ts"]
