# Mine-sim — full-local build. There is NO backend: the whole game runs in the
# browser (public/, with the simulation in a Web Worker). This image just serves
# the static files through a tiny zero-dependency Node server, so it is trivially
# scalable and could be swapped for nginx or any static CDN.
FROM node:22-bookworm-slim

WORKDIR /app

# OS security patches; drop npm/corepack (unused at runtime, only CVE surface).
RUN apt-get update && apt-get upgrade -y \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
            /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
  && apt-get purge -y --allow-remove-essential perl-base \
  && rm -rf /var/lib/apt/lists/*

# No dependencies to install — just the static client and the static server.
COPY public ./public
COPY serve.js ./

ENV NODE_ENV=production
ENV PORT=3200
EXPOSE 3200

# Drop root: run as the built-in unprivileged user.
USER node

CMD ["node", "serve.js"]
