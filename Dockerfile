# Mine-sim — Node on the latest Alpine image.
FROM node:alpine

WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Server + game logic + static client.
COPY . .

# Persisted admin password lives here; mount a volume at DATA_DIR for it to
# survive redeploys. Owned by the unprivileged `node` user.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app

ENV NODE_ENV=production
ENV PORT=3200
EXPOSE 3200

# Drop root: run as the built-in unprivileged user.
USER node

CMD ["node", "server.js"]
