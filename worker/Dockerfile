# Vibecode Heaven Worker — Runs kiro-cli acp inside ACA Jobs
FROM node:22-slim

# Install git, curl, unzip (needed for clone/push and kiro-cli installer),
# and netcat-openbsd (needed by ta-mcp-connect to bridge to the MCP proxy sidecar)
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates unzip netcat-openbsd && \
    rm -rf /var/lib/apt/lists/*

# Install kiro-cli
RUN curl -fsSL https://cli.kiro.dev/install | bash && \
    ln -sf /root/.local/bin/kiro-cli /usr/local/bin/kiro-cli

WORKDIR /app

# Install worker dependencies
COPY package.json ./
RUN npm install --omit=dev

# Copy worker script
COPY worker.js ./
COPY spawn-env.js ./
COPY shared-branch-utils.js ./
COPY verdict-mcp-server.js ./
COPY pr-review-mcp-server.js ./
COPY pr-complete-mcp-server.js ./
COPY ta-mcp-connect ./
RUN chmod +x ./ta-mcp-connect

# Create workspace directory
RUN mkdir -p /workspace

# Deliberately NOT setting NODE_ENV=production here (unlike the root Dockerfile's
# orchestrator image). This container's whole job is to `npm ci`/`npm install`
# inside an arbitrary CLONED target repo (see setupRepo() in worker.js) — and that
# repo needs its devDependencies (test runner, compiler, type stubs) actually
# present on disk so the agent can run tests/builds. npm's `omit` config defaults
# to 'dev' whenever NODE_ENV=production, which silently skips writing
# devDependencies to node_modules even though the install reports success (they
# still get resolved into package-lock.json, just never installed). That bug
# made vitest/typescript disappear from every agent session's node_modules.
# Nothing in worker.js itself reads process.env.NODE_ENV, so there is no
# runtime behavior here that depends on it — do not re-add it.

CMD ["node", "worker.js"]
