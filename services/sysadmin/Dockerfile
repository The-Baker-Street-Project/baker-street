FROM node:22-alpine AS builder

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy root workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY services/sysadmin/package.json services/sysadmin/

# Install all deps
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY services/sysadmin/ services/sysadmin/

# Build shared first, then sysadmin
RUN pnpm --filter=@bakerst/shared build && pnpm --filter=@bakerst/sysadmin build

# --- Production ---
FROM node:22-alpine

# Install cosign for image signature verification
COPY --from=gcr.io/projectsigstore/cosign:v2.4.1 /ko-app/cosign /usr/local/bin/cosign

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY services/sysadmin/package.json services/sysadmin/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/services/sysadmin/dist services/sysadmin/dist
COPY services/sysadmin/prompts services/sysadmin/prompts

ENV NODE_ENV=production
EXPOSE 3090

USER 1000
CMD ["node", "services/sysadmin/dist/index.js"]
