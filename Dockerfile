# Mine-sim — Node on Debian (bookworm-slim). glibc lets better-sqlite3 install
# its prebuilt native binary (no compiler needed), incl. for multi-arch builds.
FROM node:22-bookworm-slim

WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Server + game logic + static client.
COPY . .

# Persisted data (admin password .env + SQLite DB) lives here; mount a volume at
# DATA_DIR so it survives redeploys. Owned by the unprivileged `node` user.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app

ENV NODE_ENV=production
ENV PORT=3200
EXPOSE 3200

# Drop root: run as the built-in unprivileged user.
USER node

CMD ["node", "server.js"]
