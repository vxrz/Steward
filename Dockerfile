# Steward container image (for a shared team server or a VM).
# For a single user the desktop executable or "npm start" is simpler.
#
#   docker build -t steward .
#   docker build --build-arg WITH_BROWSER=1 -t steward .   # include Chromium for browser steps
#
# The base image is pinned by digest (Dependabot keeps it current). The app runs
# as the unprivileged "node" user (uid 1000), its files belong to root (read-only
# for the app) and it only writes to /data (and /tmp for browser steps), so it
# works with a read-only root file system – see docker-compose.yml.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# The server with its production dependencies only (the web UI's libraries are bundled into web/dist)
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS app
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace=server --workspace=shared --no-audit --no-fund
COPY LICENSE NOTICE ./
COPY shared ./shared
COPY server/tsconfig.json ./server/
COPY server/src ./server/src
COPY server/assets ./server/assets
COPY examples ./examples
COPY --from=build /app/web/dist ./web/dist

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG WITH_BROWSER=0
LABEL org.opencontainers.image.title="Steward" \
      org.opencontainers.image.description="Repeatable, auditable service procedures for Siemens Insights Hub, Industrial Edge and any REST platform" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
ENV NODE_ENV=production \
    SM_HOST=0.0.0.0 \
    SM_PORT=4310 \
    SM_DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    TSX_DISABLE_CACHE=1
COPY --from=app /app /app
# The app does not need npm, npx, yarn or corepack at runtime: removing them shrinks the attack surface
# (and the vulnerability reports – their bundled dependencies are not Steward's).
# (the CLI of the installed playwright package, so the browser matches its version)
RUN if [ "$WITH_BROWSER" = "1" ]; then node node_modules/playwright/cli.js install --with-deps chromium && rm -rf /var/lib/apt/lists/*; fi \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
VOLUME ["/data"]
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4310/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# node directly (not npm) so SIGTERM reaches the server and it shuts down cleanly
CMD ["node", "--import", "tsx", "server/src/index.ts"]
