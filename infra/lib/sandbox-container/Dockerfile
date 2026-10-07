FROM public.ecr.aws/docker/library/node:22-trixie-slim AS agent-builder
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY agent/package.json agent/package-lock.json* ./
RUN npm ci
COPY agent/ ./
RUN npm run build

# ── npm cache warm stage ──────────────────────────────────────────
# Pre-populate an npm cache with the react-starter-pack template's dependencies
# (Cloudscape, Amplify, etc. — the heavy ones) so the FIRST `npm install` inside
# a template-seeded sandbox is a cache hit instead of a cold registry download.
# We keep only the cache (~/.npm), not node_modules: the workdir is wiped per
# session (see cleanWorkdir in the agent), but the cache lives in the sandbox
# user's home and survives, so every session's install benefits.
FROM public.ecr.aws/docker/library/node:22-trixie-slim AS npm-cache-warmer
WORKDIR /warm
# Only the manifests are needed to populate the cache (staged by
# generate-template-deps.cjs, keyed to the pinned submodule).
COPY template-deps/frontend/package.json template-deps/frontend/package-lock.json* ./frontend/
COPY template-deps/backend/package.json template-deps/backend/package-lock.json* ./backend/
# Populate /warm/.npm for the CONTAINER's platform only (linux/x64). Without
# --os/--cpu, warming under an emulated build pulled darwin esbuild/rollup
# binaries into the cache; npm's optional-dependency handling (npm/cli#4828)
# then installed those macOS binaries in the Linux container, so Vite's esbuild
# dep-optimize crashed ("service is no longer running") and the preview stayed a
# white pane. Pinning the platform keeps only linux-x64 binaries in the cache.
RUN cd frontend && npm install --cache /warm/.npm --no-audit --no-fund --ignore-scripts --os=linux --cpu=x64 || true
RUN cd backend && npm install --cache /warm/.npm --no-audit --no-fund --ignore-scripts --os=linux --cpu=x64 || true

FROM public.ecr.aws/docker/library/node:22-trixie-slim

# Cache-bust to force package updates on rebuild. Bump this (or build --no-cache)
# whenever OS CVEs need picking up — it invalidates the apt layer below so
# `apt-get upgrade` re-runs against fresh package lists.
ARG CACHE_BUST=20260915

# Upgrade all system packages to pick up security patches, then install deps
RUN echo "cache-bust: ${CACHE_BUST}" && apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    procps \
    net-tools \
    iproute2 \
    git \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Create sandbox user
RUN useradd -m -s /bin/bash sandbox

# Set up agent directory
WORKDIR /opt/agent
COPY agent/package.json agent/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=agent-builder /build/dist/ ./dist/

# Set up project template directory
RUN mkdir -p /opt/template

# Set up the project working directory
RUN mkdir -p /home/sandbox/project && chown -R sandbox:sandbox /home/sandbox

# Pre-warmed npm cache for the react-starter-pack template deps. Lives in the
# sandbox user's home (npm's default cache dir), which survives the per-session
# workdir wipe — so the first `npm install` in a seeded project hits the cache
# instead of downloading Cloudscape/Amplify/etc. cold. Best-effort: if absent,
# npm just falls back to the network.
COPY --from=npm-cache-warmer --chown=sandbox:sandbox /warm/.npm /home/sandbox/.npm

# Copy entrypoint
COPY entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

# Environment
ENV WORKDIR=/home/sandbox/project
ENV AGENT_PORT=8080
# NOTE: NODE_ENV is intentionally NOT set globally.
# The agent runs in production mode via the entrypoint.
# User projects need devDependencies (vite, etc.) which npm
# skips when NODE_ENV=production.

EXPOSE 8080

USER sandbox

ENTRYPOINT ["/opt/entrypoint.sh"]
