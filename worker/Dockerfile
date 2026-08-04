# Vibecode Heaven Worker — Runs kiro-cli acp inside ACA Jobs
FROM node:22-slim

# Install git, curl, unzip (needed for clone/push and kiro-cli installer)
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates unzip && \
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
COPY verdict-mcp-server.js ./

# Create workspace directory
RUN mkdir -p /workspace

ENV NODE_ENV=production

CMD ["node", "worker.js"]
