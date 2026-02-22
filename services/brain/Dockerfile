FROM node:22-alpine AS builder

# Native build tools for better-sqlite3
RUN apk add --no-cache python3 make g++

# Tell node-gyp to use locally installed headers (avoids downloading from unofficial-builds.nodejs.org)
ENV npm_config_nodedir=/usr/local

# Enable pnpm and fix gyp_main.py permissions (pnpm 10 packaging bug)
RUN corepack enable && corepack prepare pnpm@latest --activate && \
    chmod +x "$(find /root/.cache/node/corepack -name gyp_main.py 2>/dev/null | head -1)" 2>/dev/null || true

WORKDIR /app

# Copy root workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY services/brain/package.json services/brain/

# Install all deps
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY services/brain/ services/brain/

# Build shared first, then brain
RUN pnpm --filter=@bakerst/shared build && pnpm --filter=@bakerst/brain build

# --- Production ---
FROM node:22-alpine

# Runtime dep for better-sqlite3
RUN apk add --no-cache libstdc++

# Enable pnpm and fix gyp_main.py permissions
RUN corepack enable && corepack prepare pnpm@latest --activate && \
    chmod +x "$(find /root/.cache/node/corepack -name gyp_main.py 2>/dev/null | head -1)" 2>/dev/null || true

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY services/brain/package.json services/brain/

# Tell node-gyp to use locally installed headers
ENV npm_config_nodedir=/usr/local

# Need build tools to install better-sqlite3 native addon
RUN apk add --no-cache python3 make g++ && \
    pnpm install --frozen-lockfile --prod && \
    apk del python3 make g++

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/services/brain/dist services/brain/dist
COPY services/brain/entrypoint.sh entrypoint.sh

ARG BRAIN_VERSION=dev
ENV BRAIN_VERSION=$BRAIN_VERSION
ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["./entrypoint.sh"]
