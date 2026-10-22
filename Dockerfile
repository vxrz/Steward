# Steward container image (for a shared team server or a VM).
# For a single user the desktop executable or "npm start" is simpler.
#
#   docker build -t steward .
#   docker build --build-arg WITH_BROWSER=1 -t steward .   # include Chromium for browser steps
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

# Runtime dependencies of the server only: the web UI's packages (React, Mantine, icons, …)
# are only needed to build web/dist and would otherwise add ~170 MB to the image.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace=server --workspace=shared && npm cache clean --force

FROM node:24-bookworm-slim
ARG WITH_BROWSER=0
WORKDIR /app
ENV NODE_ENV=production \
    SM_HOST=0.0.0.0 \
    SM_PORT=4310 \
    SM_DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=deps /app /app
COPY shared/ shared/
COPY server/ server/
COPY examples/ examples/
COPY --from=build /app/web/dist web/dist
# (the CLI of the installed playwright package, so the browser matches its version)
RUN if [ "$WITH_BROWSER" = "1" ]; then node node_modules/playwright/cli.js install --with-deps chromium && rm -rf /var/lib/apt/lists/*; fi \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4310/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Node directly (not "npm start"): one process instead of npm + tsx CLI + node, faster start,
# and SIGTERM from "docker stop" reaches the server's shutdown handler.
# The working directory stays /app so root scripts (e.g. "npm run db:copy") keep working.
CMD ["node", "--import", "tsx", "server/src/index.ts"]
