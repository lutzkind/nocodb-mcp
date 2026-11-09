# Multi-stage build for nocodb-mcp
#
# - Builder stage compiles TypeScript
# - Runtime stage is minimal Node 20 slim with just dist/ and prod deps
#
# This image runs the HTTP transport by default — suitable for Dokploy, Coolify,
# Railway, Fly, Render, plain `docker run`, or any container PaaS.
#
# To run stdio instead (e.g. for Smithery, which uses startCommand from
# smithery.yaml), override the CMD: `CMD ["node", "dist/index-stdio.js"]`.

FROM node:20-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app

# CVE-2026-111497: install the fixed libbrotli1 runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libbrotli1 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Listen on all interfaces inside the container so the host / reverse proxy
# can reach the port. Override at runtime with -e HOST=... if needed.
ENV HOST=0.0.0.0
ENV PORT=3000

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY README.md LICENSE ./

EXPOSE 3000

# Container health check — Dokploy / Docker / Kubernetes use this signal.
# Polls /health every 30s, allowing 5s for response.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index-http.js"]
