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
# Stamped by the deploy; "dev" for local builds, "main" for build-push.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY CHANGELOG.md ./
# Numeric, not `USER node`: with a named user, the ksvc's runAsNonRoot can't
# verify non-root and the pod fails with CreateContainerConfigError.
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/server/server.js"]
