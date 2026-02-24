FROM node:22-alpine AS builder

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy root workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY services/voice/package.json services/voice/

# Install all deps
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY services/voice/ services/voice/

# Build shared first, then voice
RUN pnpm --filter=@bakerst/shared build && pnpm --filter=@bakerst/voice build

# --- Production ---
FROM node:22-alpine

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY services/voice/package.json services/voice/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/services/voice/dist services/voice/dist

ENV NODE_ENV=production

CMD ["node", "services/voice/dist/index.js"]
