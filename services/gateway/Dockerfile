FROM node:22-alpine AS builder

# Native build tools for better-sqlite3
RUN apk add --no-cache python3 make g++

# Tell node-gyp to use locally installed headers (avoids downloading from unofficial-builds.nodejs.org)
ENV npm_config_nodedir=/usr/local

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate && \
    chmod +x "$(find /root/.cache/node/corepack -name gyp_main.py 2>/dev/null | head -1)" 2>/dev/null || true

WORKDIR /app

# Copy root workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY services/gateway/package.json services/gateway/

# Install all deps
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY services/gateway/ services/gateway/

# Build shared first, then gateway
RUN pnpm --filter=@bakerst/shared build && pnpm --filter=@bakerst/gateway build

# --- Production ---
FROM node:22-alpine

# Runtime dep for better-sqlite3
RUN apk add --no-cache libstdc++

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate && \
    chmod +x "$(find /root/.cache/node/corepack -name gyp_main.py 2>/dev/null | head -1)" 2>/dev/null || true

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY services/gateway/package.json services/gateway/

# Tell node-gyp to use locally installed headers
ENV npm_config_nodedir=/usr/local

# Need build tools to install better-sqlite3 native addon
RUN apk add --no-cache python3 make g++ && \
    pnpm install --frozen-lockfile --prod && \
    apk del python3 make g++

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/services/gateway/dist services/gateway/dist

ENV NODE_ENV=production

CMD ["node", "services/gateway/dist/index.js"]
