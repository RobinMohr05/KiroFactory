# ─────────────────────────────────────────────────────────────────────────────
# Vibecode Heaven MCP Proxy — Per-Session MCP Server Sidecar
#
# Based on the ta-mcp-proxy pattern from devcontainer-features.
# Each Kiro session gets its own MCP proxy container for full isolation
# (no credential sharing between sessions).
#
# The proxy:
#   - Listens on TCP port 9090 (configurable via MCP_PROXY_PORT)
#   - Reads /config/servers.json for MCP server definitions
#   - Spawns MCP servers on-demand when a client connects
#   - Multiplexes multiple MCP server connections over a single port
#   - Injects per-session credentials via environment variables
#
# Target: <150MB image, fast cold start
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-alpine AS base

LABEL org.opencontainers.image.title="Vibecode Heaven MCP Proxy"
LABEL org.opencontainers.image.description="Per-session MCP proxy sidecar — spawns and multiplexes MCP servers"
LABEL org.opencontainers.image.source="https://github.com/RobinMohr/vibecode-heaven"

# ─── Install system dependencies ─────────────────────────────────────────────

RUN apk add --no-cache \
    curl \
    git \
    python3 \
    py3-pip \
    bash

# ─── Install uv/uvx (for Python-based MCP servers like azure-devops-mcp) ────

RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && ln -sf /root/.local/bin/uv /usr/local/bin/uv \
    && ln -sf /root/.local/bin/uvx /usr/local/bin/uvx

# ─── Install npx globally (for Node-based MCP servers) ───────────────────────

RUN npm install -g npx

# ─── Copy proxy server ───────────────────────────────────────────────────────

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY proxy.js ./

# ─── Runtime configuration ────────────────────────────────────────────────────

# Port the proxy listens on (worker connects via ta-mcp-connect)
ENV MCP_PROXY_PORT=9090

# Path to the servers.json config file (mounted or generated at startup)
ENV MCP_SERVERS_CONFIG=/config/servers.json

# Create config directory (will be populated by orchestrator at runtime)
RUN mkdir -p /config

# Health check — proxy exposes /healthz on MCP_PROXY_PORT + 1
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
    CMD wget -qO- http://localhost:9091/healthz || exit 1

EXPOSE 9090
EXPOSE 9091

CMD ["node", "proxy.js"]
