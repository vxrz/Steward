# Service Manager container image (for a shared team server or a VM).
# For a single user the desktop executable or "npm start" is simpler.
#
#   docker build -t service-manager .
#   docker build --build-arg WITH_BROWSER=1 -t service-manager .   # include Chromium for browser steps
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ARG WITH_BROWSER=0
WORKDIR /app
ENV NODE_ENV=production \
    SM_HOST=0.0.0.0 \
    SM_PORT=4310 \
    SM_DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app /app
RUN if [ "$WITH_BROWSER" = "1" ]; then npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*; fi \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4310/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
