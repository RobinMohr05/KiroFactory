# ─── Stage 1: Build TypeScript ────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace root package files for install
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# Install all dependencies (including devDependencies for tsc)
RUN npm ci

# Copy backend source and compile
COPY backend/tsconfig.json backend/
COPY backend/src/ backend/src/

RUN npm run build -w backend

# ─── Stage 2: Production Runtime ─────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Add labels for container registry
LABEL org.opencontainers.image.title="KiroFactory Backend"
LABEL org.opencontainers.image.description="KiroFactory orchestrator — Express + WebSocket server"
LABEL org.opencontainers.image.source="https://github.com/RobinMohr/KiroFactory"

# Create non-root user for security
RUN addgroup -S kirofactory && adduser -S kirofactory -G kirofactory

WORKDIR /app

# Copy workspace root package files
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled backend from builder
COPY --from=builder /app/backend/dist/ backend/dist/

# Copy SQL schema (used by migrate on startup)
COPY backend/sql/ backend/sql/

# Copy static frontend assets (served by Express)
COPY frontend/public/ frontend/public/

# Switch to non-root user
USER kirofactory

# Expose the default server port
EXPOSE 3500

# Environment variables (defaults — override at deploy time)
ENV NODE_ENV=production
ENV PORT=3500

# Health check — calls the public /api/health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3500/api/health || exit 1

# Start the compiled server
CMD ["node", "backend/dist/index.js"]
