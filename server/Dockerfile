# ---- Node.js build stage (server + shared) ----
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json ./
COPY shared/ ./shared/
RUN cd shared && npm install && npm run build

COPY server/package.json ./server/
RUN cd server && npm install

COPY server/tsconfig.json server/knexfile.ts ./server/
COPY server/src/ ./server/src/
RUN cd server && npm run build

# ---- Production stage ----
FROM node:24-alpine AS production
WORKDIR /app

RUN apk add --no-cache openssh-client

COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/shared/dist/ ./shared/dist/

COPY --from=builder /app/server/package.json ./server/
COPY package.json ./
RUN cd server && npm install --omit=dev

COPY --from=builder /app/server/dist/ ./server/dist/

# Agent installer scripts + VERSION file (used by GET /api/agent/version)
COPY agent/installer/ ./agent/installer/
COPY agent/VERSION ./agent/

# All agent binaries are built and code-signed locally (Windows, Linux, macOS).
# The RegularUpdate script builds Windows + MSI locally, then cross-compiles
# Linux/macOS via SSH on remote hosts. All outputs land in agent/dist/.
RUN mkdir -p ./agent/dist
COPY agent/dist/ ./agent/dist/

# Obli.tools VERSION file (read by GET /api/agent/desktop-version to drive the update banner).
COPY obli.tools/VERSION ./obli.tools/

# Obli.tools release binaries (build on Windows/macOS locally).
RUN mkdir -p ./obli.tools/dist
COPY obli.tools/dist/ ./obli.tools/dist/

COPY server/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

WORKDIR /app/server
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
