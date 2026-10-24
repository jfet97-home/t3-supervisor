FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm && corepack install -g pnpm@12.14.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY ui/ ./ui/
COPY vite.config.ts ./vite.config.ts
RUN pnpm build && pnpm prune --prod

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/ui-dist ./ui-dist
COPY --from=build /app/package.json ./package.json
RUN chmod 755 /app/dist/cli.js && ln -s /app/dist/cli.js /usr/local/bin/t3-supervisor && mkdir /data && chown 501:20 /data
ENV NODE_ENV=production DATA_DIRECTORY=/data T3_URL=http://host.docker.internal:3773
USER 501:20
ARG VERSION=development
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/jfet97/t3-supervisor" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
CMD ["node", "dist/main.js"]
