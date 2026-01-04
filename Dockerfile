FROM node:20-bookworm-slim

WORKDIR /app

# Needed for native deps like better-sqlite3 (node-gyp)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY bin ./bin

# Persist account config across restarts
RUN mkdir -p /data
VOLUME ["/data"]

ENV NODE_ENV=production
ENV PORT=48123
ENV ACCOUNT_CONFIG_PATH=/data/accounts.json

# Optional: mount Antigravity's state.vscdb and point ANTIGRAVITY_DB_PATH at it
# ENV ANTIGRAVITY_DB_PATH=/data/state.vscdb

# API port + OAuth callback port (default 51121)
EXPOSE 48123 51121

CMD ["node", "src/index.js"]
