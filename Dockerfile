# KiroFactory — Backend + Frontend container
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

# Stage 2: Production
FROM node:22-slim AS production
WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy workspace package.json files
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# Install production dependencies only
RUN npm ci --omit=dev

# Copy compiled backend from build stage
COPY --from=build /app/backend/dist ./backend/dist

# Copy frontend static files
COPY frontend/public ./frontend/public

# Copy SQL migrations
COPY backend/sql ./backend/sql

ENV NODE_ENV=production
ENV PORT=3500
EXPOSE 3500

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3500/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "backend/dist/index.js"]
