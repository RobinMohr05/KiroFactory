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
RUN curl -fsSL https://cli.kiro.dev/install | bash && \
    ln -sf /root/.local/bin/kiro-cli /usr/local/bin/kiro-cli

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

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3500/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "backend/dist/index.js"]
