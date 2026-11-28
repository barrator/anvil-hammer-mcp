# syntax=docker/dockerfile:1
#
# anvil-hammer-mcp hosted image. Base images are pinned by digest; Dependabot
# proposes updates. The runtime has no shell and no package manager.

# --- Build: compile TypeScript, keep production dependencies only ---
FROM node:26-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund
# Data folders, created here so that new volumes start with the right owner and mode.
RUN mkdir -p /out/data/config/oauth /out/data/backups /out/data/index /out/data/logs \
 && chmod -R 0700 /out/data

# --- Runtime: distroless Node.js, non-root user 65532 ---
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:a84242e747fbb5aaaa0180c273b6f7130ca34b3300082192ef58eea96089eb3c
WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build --chown=65532:65532 /out/data /data
ENV NODE_ENV=production \
    WA_HTTP_HOST=0.0.0.0 \
    WA_HTTP_PORT=8080 \
    WA_OAUTH_DIR=/data/config/oauth \
    WA_BACKUP_DIR=/data/backups \
    WA_INDEX_DIR=/data/index \
    WA_LOG_DIR=/data/logs
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/index.js"]
CMD ["http"]
