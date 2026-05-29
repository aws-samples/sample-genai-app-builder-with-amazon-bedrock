FROM public.ecr.aws/docker/library/node:22.22.3-slim AS agent-builder
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY agent/package.json agent/package-lock.json* ./
RUN npm ci
COPY agent/ ./
RUN npm run build

FROM public.ecr.aws/docker/library/node:22.22.3-slim

# Cache-bust to force package updates on rebuild
ARG CACHE_BUST=1

# Upgrade all system packages to pick up security patches, then install deps
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
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
