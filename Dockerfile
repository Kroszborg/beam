# Beam — one container: signaling server + the web app it serves.
#
#   docker build -t beam .
#   docker run -p 8787:8787 beam            # http://localhost:8787
#
# Browsers only allow the crypto + service-worker features Beam needs on
# https:// (or localhost), so put it behind TLS for real use — see
# docker-compose.yml for a ready Caddy setup with automatic certificates.

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile
COPY packages packages
# Empty signaling URL → the app talks to the origin it was served from.
ENV VITE_SIGNALING_URL=""
RUN pnpm --filter @beam/client build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile --prod --filter @beam/server... \
  && pnpm store prune
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY --from=build /app/packages/client/dist packages/client/dist

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    STATIC_DIR=/app/packages/client/dist
EXPOSE 8787
# Writable home for optional encrypted copies (STORE_ENABLED / STORE_DIR).
RUN mkdir -p /data/store && chown -R node:node /data
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
# tsx is resolved from the server package, so run from there.
WORKDIR /app/packages/server
CMD ["node", "--import", "tsx", "src/index.ts"]
