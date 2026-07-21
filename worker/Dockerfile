# ─────────────────────────────────────────────────────────────────────────────
# KiroFactory Worker — Slim container for Kiro ACP session execution
#
# Target: <300MB image, <10s cold start
# Base: Node.js 20 slim (Debian bookworm)
# Includes: kiro-cli, uv/uvx (Python MCP servers), ta-mcp-connect bridge
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-slim AS base

LABEL org.opencontainers.image.title="KiroFactory Worker"
LABEL org.opencontainers.image.description="Slim Kiro ACP session worker — spawns kiro-cli, streams NDJSON to orchestrator"
LABEL org.opencontainers.image.source="https://github.com/RobinMohr/KiroFactory"

# ─── Install system dependencies ─────────────────────────────────────────────

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# ─── Install kiro-cli ─────────────────────────────────────────────────────────

RUN curl -fsSL https://cli.kiro.dev/install | bash \
    && ln -sf /root/.kiro-cli/bin/kiro-cli /usr/local/bin/kiro-cli

# ─── Install uv/uvx (for Python-based MCP servers) ───────────────────────────

RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && ln -sf /root/.local/bin/uv /usr/local/bin/uv \
    && ln -sf /root/.local/bin/uvx /usr/local/bin/uvx

# ─── Install @agentclientprotocol/sdk ─────────────────────────────────────────

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ─── Copy worker scripts ─────────────────────────────────────────────────────

COPY worker.js ./
COPY ta-mcp-connect ./ta-mcp-connect

RUN chmod +x ta-mcp-connect

# ─── Runtime configuration ────────────────────────────────────────────────────

# Environment variables (override at deploy time)
ENV NODE_ENV=production
ENV ORCHESTRATOR_WS_URL=ws://orchestrator:3500
ENV SESSION_ID=""
ENV WORKER_SECRET=""
ENV AGENT_NAME=developer
ENV WORKING_DIR=/workspace
ENV TIMEOUT_SECONDS=900
ENV MCP_PROXY_HOST=localhost
ENV MCP_PROXY_PORT=9090

# Create workspace directory (will be mounted or populated at runtime)
RUN mkdir -p /workspace

# Health check — worker.js exposes a simple /healthz on port 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/healthz || exit 1

EXPOSE 8080

# Run as non-root (kiro-cli and uv binaries are in /usr/local/bin)
RUN groupadd -r worker && useradd -r -g worker -d /app worker \
    && chown -R worker:worker /app /workspace
USER worker

CMD ["node", "worker.js"]
