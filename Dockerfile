# Mine-sim — Node on Debian (bookworm-slim). glibc lets better-sqlite3 install
# its prebuilt native binary (no compiler needed), incl. for multi-arch builds.
FROM node:22-bookworm-slim

WORKDIR /app

# Apply outstanding OS security patches from the base image.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# Install production dependencies first (better layer caching). npm is only needed
# at build time; remove it (and corepack) afterwards — their bundled node_modules
# are the only source of CVEs in this image and aren't used to run the server.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
            /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
  # perl-base ships in the base image but nothing here uses it (no installed
  # reverse-deps); dropping it clears its Debian CVEs, incl. the only CRITICAL.
  && apt-get purge -y --allow-remove-essential perl-base \
  && rm -rf /var/lib/apt/lists/*

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
