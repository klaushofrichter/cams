FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server ./server
COPY web ./web
RUN npm run build

FROM node:26-alpine
WORKDIR /app
# Thumbnails of recorded clips (server/recordings/thumbnail.ts).
RUN apk add --no-cache ffmpeg
ENV CACHE_DIR=/var/cache/cams
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
# Stamped by the deploy; "dev" for local builds, "main" for build-push.
# Declared after the dependency and build layers: a new version or date
# changes every layer below its ARG, so earlier they rebuilt npm ci each time.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ARG BUILD_DATE=
ENV BUILD_DATE=$BUILD_DATE
COPY CHANGELOG.md ./
# CACHE_DIR must exist and be writable by the non-root user below, or the
# first fill() fails outright (DiskCache.ensureDir()'s mkdir has nothing to
# create it with once USER drops root).
RUN mkdir -p /var/cache/cams && chown 1000:1000 /var/cache/cams
# Numeric, not `USER node`: with a named user, the ksvc's runAsNonRoot can't
# verify non-root and the pod fails with CreateContainerConfigError.
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/server/server.js"]
