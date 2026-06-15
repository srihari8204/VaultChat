# Multi-stage build for the VaultChat backend.
# The same image runs every role (api, ws-gateway, fan-out worker, push worker);
# the role is selected by overriding the command in docker-compose / k8s, e.g.
#   command: ["node", "workers/fanout.js"]
#
# Debian slim (not alpine) so the bcrypt native build resolves cleanly.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# npm install (not ci) so the build tolerates a lockfile that predates a new
# dependency — it reconciles package.json + lock and installs.
RUN npm install --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# curl for the container healthcheck
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1
CMD ["node", "server.js"]
