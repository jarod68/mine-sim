# Mine-sim — Node on the latest Alpine image.
FROM node:alpine

WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Server + game logic + static client.
COPY . .

ENV NODE_ENV=production
ENV PORT=3200
EXPOSE 3200

CMD ["node", "server.js"]
