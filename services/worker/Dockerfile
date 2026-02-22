FROM node:22-alpine AS builder

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy root workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY services/worker/package.json services/worker/

# Install all deps
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY services/worker/ services/worker/

# Build shared first, then worker
RUN pnpm --filter=@bakerst/shared build && pnpm --filter=@bakerst/worker build

# --- Production ---
FROM node:22-alpine

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY services/worker/package.json services/worker/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/services/worker/dist services/worker/dist

ENV NODE_ENV=production

CMD ["node", "--import", "./services/worker/dist/instrument.js", "services/worker/dist/index.js"]
