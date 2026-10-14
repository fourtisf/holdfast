# syntax=docker/dockerfile:1
#
# Holdfast container images: one Dockerfile, two runtime targets.
#
#   services (default)  every Node backend in one image. The working directory and command pick
#                       the service: each runs its package.json start script's command in the
#                       package directory, exactly as `pnpm run` would (default: the api).
#                         docker build -t holdfast .
#                         -w /app/apps/api       tsx src/main.ts           (default)
#                         -w /app/apps/indexer   tsx src/main.ts
#                         -w /app/apps/keeper    tsx src/main-keeper.ts
#                         -w /app/apps/keeper    tsx src/main-payout.ts
#                         -w /app/apps/launcher  tsx src/main.ts
#                         -w /app/apps/notifier  tsx src/main.ts           (Telegram bot)
#                         -w /app                pnpm db:migrate           (one-shot)
#                       docker-compose.yml wires these up with the env overrides they need
#                       (database host, absolute keypair / metadata paths). The commands run
#                       directly rather than through `pnpm run` because pnpm exits as soon as
#                       it relays SIGTERM, which cuts the services' own graceful shutdown short.
#   web                 the Next.js frontend (`next start` on :3000). NEXT_PUBLIC_* are inlined into
#                       the browser bundle at build time, so they are build args:
#                         docker build --target web -t holdfast-web \
#                           --build-arg NEXT_PUBLIC_API_URL=https://api.example.com .
#
# Dev dependencies stay in both runtime images on purpose: every service's start script runs its
# TypeScript through `tsx`, and `next start` needs `typescript` to load next.config.ts. The images
# install only the workspace projects they run (services: everything but the web app; web: the
# web app and @holdfast/core), so Next/React never ship in the backend image and vice versa.
# The tsc output (dist/) is built too, so `node dist/main.js` also works from a package directory.
#
# NODE_IMAGE lets a build use a mirror or a base image with extra CA certificates.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- base: Node + the pnpm version pinned in package.json#packageManager (via corepack) -------
FROM ${NODE_IMAGE} AS base
ENV COREPACK_HOME=/usr/local/share/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package.json ./
RUN corepack enable pnpm \
 && corepack install \
 && pnpm --version

# ---- fetch: every package in the lockfile into the store; cached until pnpm-lock.yaml changes ---
# `pnpm fetch` also fills node_modules/.pnpm with every package; drop it so the filtered installs
# below only link what their target needs.
FROM base AS fetch
ENV CI=true
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --store-dir /pnpm/store \
 && rm -rf node_modules

# ---- build-services: install the backend projects offline, then compile ----------------------
FROM fetch AS build-services
COPY . .
RUN pnpm install --frozen-lockfile --offline --store-dir /pnpm/store --filter '!@holdfast/web'
RUN pnpm --filter './packages/*' run build \
 && pnpm --filter './apps/*' --filter '!@holdfast/web' run build

# ---- build-web: install the web app (+ @holdfast/core), build core, then `next build` ---------
FROM fetch AS build-web
COPY . .
RUN pnpm install --frozen-lockfile --offline --store-dir /pnpm/store --filter '@holdfast/web...'
RUN pnpm --filter '@holdfast/web^...' run build
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_WS_URL=ws://localhost:4000/ws
ARG NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
ARG NEXT_PUBLIC_SOLANA_CLUSTER=devnet
ARG NEXT_PUBLIC_USE_MOCKS=0
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL} \
    NEXT_PUBLIC_SOLANA_RPC_URL=${NEXT_PUBLIC_SOLANA_RPC_URL} \
    NEXT_PUBLIC_SOLANA_CLUSTER=${NEXT_PUBLIC_SOLANA_CLUSTER} \
    NEXT_PUBLIC_USE_MOCKS=${NEXT_PUBLIC_USE_MOCKS}
RUN pnpm --filter @holdfast/web run build \
 && rm -rf apps/web/.next/cache

# ---- web runtime -----------------------------------------------------------------------------
FROM base AS web
ENV NODE_ENV=production \
    PATH=/app/apps/web/node_modules/.bin:$PATH
COPY --from=build-web /app /app
# `next start` writes its image-optimisation cache under .next/cache.
RUN mkdir -p /app/apps/web/.next/cache \
 && chown node:node /app/apps/web/.next/cache
USER node
WORKDIR /app/apps/web
EXPOSE 3000
# = @holdfast/web `start`
CMD ["next", "start", "--port", "3000"]

# ---- services runtime (default target) -------------------------------------------------------
FROM base AS services
ENV NODE_ENV=production \
    PATH=/app/node_modules/.bin:$PATH
COPY --from=build-services /app /app
# Keypairs are mounted read-only at /app/keys; uploaded images + metadata JSON live in /app/data
# (shared by the api and the launcher through a volume in docker-compose.yml). Point
# KEEPER_KEYPAIR / LAUNCHER_KEYPAIR / METADATA_STORE there with absolute paths: the services run
# from their package directory, so the relative paths in .env.example would not resolve.
RUN mkdir -p /app/data/metadata /app/keys \
 && chown -R node:node /app/data
USER node
WORKDIR /app/apps/api
EXPOSE 4000 4100
# = @holdfast/api `start`
CMD ["tsx", "src/main.ts"]
