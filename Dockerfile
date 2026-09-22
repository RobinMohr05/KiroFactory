# Vibecode Heaven — Backend + Frontend container
# Monorepo (npm workspaces) multi-stage build

# Stage 1: Build
FROM node:22-slim AS build
WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy workspace package.json files
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# Install all dependencies (workspace-aware)
RUN npm ci

# Copy backend source and compile
COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
RUN npm run build -w backend

# Copy frontend source and build
COPY frontend/tsconfig.json frontend/tsconfig.app.json frontend/tsconfig.node.json ./frontend/
COPY frontend/vite.config.ts ./frontend/
COPY frontend/index.html ./frontend/
COPY frontend/src ./frontend/src
# public/ must exist before the build: vite.config.ts's syncPublicStylesheet
# plugin copies src/style.css into public/style.css via copyFileSync, which
# fails with ENOENT if the destination directory isn't already present.
COPY frontend/public ./frontend/public
RUN npm run build -w frontend

# Stage 2: Production
FROM node:22-slim AS production
WORKDIR /app

# Install curl + unzip (needed for kiro-cli installer — its Linux install path
# unzips the downloaded package) — git is NOT needed here because the planner
# uses MCP servers for repo access, not git clone.
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install kiro-cli — needed for forceLocal sessions (e.g. task planner)
# that run as local KiroRunner child processes inside the orchestrator container.
# The installer drops the binary in root's ~/.local/bin; move it to a system-wide
# location so the non-root `node` user (set below) can still execute it — a symlink
# into /root wouldn't work because /root isn't traversable by other users.
RUN curl -fsSL https://cli.kiro.dev/install | bash && \
    mv /root/.local/bin/kiro-cli /usr/local/bin/kiro-cli && \
    chmod 755 /usr/local/bin/kiro-cli

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy workspace package.json files
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# Install production dependencies only
RUN npm ci --omit=dev

# Copy compiled backend from build stage
COPY --from=build /app/backend/dist ./backend/dist

# Copy built React frontend from build stage
COPY --from=build /app/frontend/dist ./frontend/dist

# Copy frontend static files (login.html, impressum.html, favicon) for non-SPA routes
COPY frontend/public ./frontend/public

ENV NODE_ENV=production
ENV PORT=3500
EXPOSE 3500

# Drop root: run the Node process as the unprivileged `node` user (UID 1000)
# that the official node: images ship. The app dir is owned by root after the
# COPY/npm ci steps above, so hand it to `node` before switching. This limits
# the blast radius of any RCE in the orchestrator process.
RUN chown -R node:node /app
# Docker's USER instruction switches uid/gid but does NOT populate $HOME, so it
# would be unset at runtime (it was /root while running as root). kiro-cli and
# npm both rely on a writable $HOME (kiro-cli config, npm's $HOME/.npm cache),
# and the local-planner path forwards HOME from process.env into the spawned
# kiro-cli child. The official node: image ships /home/node owned by UID 1000.
ENV HOME=/home/node
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3500/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "backend/dist/index.js"]
