FROM node:20-bookworm-slim

WORKDIR /app

# Needed for native deps like better-sqlite3 (node-gyp)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy package files first for layer caching
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/
COPY bin/ ./bin/

ENV NODE_ENV=production
ENV PORT=48123

# API port + OAuth callback port (default 51121)
EXPOSE 48123 51121

# Use local source code
CMD ["node", "src/index.js"]
