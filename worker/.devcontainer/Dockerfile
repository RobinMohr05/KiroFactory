# KiroFactory Worker devcontainer — runs kiro-cli acp both as an ACA Job (hosted)
# and as a one-shot local Docker container inside the kirofactory-docker WSL distro.
#
# Build context is the worker/ folder (one level up from this file), same as the
# Dockerfile it replaces: `docker build -f worker/.devcontainer/Dockerfile worker/`
# or `devcontainer build --workspace-folder worker/`.
FROM node:22-slim

# Install git, curl, unzip (needed for clone/push and kiro-cli installer),
# and netcat-openbsd (needed by ta-mcp-connect to bridge to the MCP proxy sidecar)
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates unzip netcat-openbsd && \
    rm -rf /var/lib/apt/lists/*

# Install kiro-cli. The installer drops the binary in root's ~/.local/bin; move
# it to a system-wide location so the non-root `node` user (set below) can still
# execute it — a symlink into /root wouldn't work because /root isn't traversable
# by other users.
RUN curl -fsSL https://cli.kiro.dev/install | bash && \
    mv /root/.local/bin/kiro-cli /usr/local/bin/kiro-cli && \
    chmod 755 /usr/local/bin/kiro-cli

WORKDIR /app

# Install worker dependencies. Use `npm ci` (not `npm install`) against the
# worker's own committed lockfile so the build is reproducible — this installs
# THIS image's deps, not the cloned target repo's (that happens at runtime in
# setupRepo(), which needs devDependencies, hence no NODE_ENV=production below).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy worker script
COPY worker.js ./
COPY spawn-env.js ./
COPY shared-branch-utils.js ./
COPY verdict-mcp-server.js ./
COPY agent-error-mcp-server.js ./
COPY task-create-mcp-server.js ./
COPY list-tasks-mcp-server.js ./
COPY pr-review-mcp-server.js ./
COPY pr-complete-mcp-server.js ./
COPY git-delivery-mcp-server.js ./
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

# Drop root: run as the unprivileged `node` user (UID 1000) shipped by the
# official node: images. This container executes arbitrary CLONED target-repo
# code (npm ci/test/build in setupRepo()), so running as root would give any
# compromise root inside the container. Hand ownership of both the app dir and
# the clone workspace to `node` so the worker can still write to them at runtime.
RUN chown -R node:node /app /workspace
# Docker's USER instruction switches uid/gid but does NOT populate $HOME, so it
# would be unset at runtime (it was /root while running as root). This image's
# job is to run npm ci/install (uses $HOME/.npm cache) inside cloned repos and
# spawn kiro-cli acp (reads/writes $HOME/.local config); spawn-env.js forwards
# HOME from process.env into the child. The official node: image ships
# /home/node owned by UID 1000.
ENV HOME=/home/node
USER node

CMD ["node", "worker.js"]
