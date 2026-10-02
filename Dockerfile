# One Dockerfile for every service:
#   docker build --build-arg APP=api    -t huddle-api .
#   docker build --build-arg APP=collab -t huddle-collab .
#   docker build --target web           -t huddle-web .
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/collab/package.json apps/collab/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .

# --- static frontend ---------------------------------------------------------
FROM deps AS web-build
ARG VITE_SENTRY_DSN=""
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
RUN pnpm --filter @huddle/web build

FROM nginx:1.27-alpine AS web
COPY infra/nginx-web.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /repo/apps/web/dist /usr/share/nginx/html

# --- node services (api / collab) ---------------------------------------------
FROM deps AS build
ARG APP
RUN test -n "$APP" || (echo "--build-arg APP=api|collab is required" && false)
RUN pnpm --filter @huddle/${APP} build \
 && pnpm --filter @huddle/${APP} deploy --prod --legacy /out \
 && cp -r packages/db/migrations /out/migrations

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production HUDDLE_MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
CMD ["node", "--enable-source-maps", "dist/index.js"]
