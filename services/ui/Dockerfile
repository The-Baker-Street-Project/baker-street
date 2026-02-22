FROM node:22-alpine AS builder

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy root workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY services/ui/package.json services/ui/

# Install deps
RUN pnpm install --frozen-lockfile --filter=@bakerst/ui...

# Copy source
COPY tsconfig.base.json ./
COPY services/ui/ services/ui/

# Build
RUN pnpm --filter=@bakerst/ui build

# --- Production ---
FROM caddy:2-alpine

# Strip file capabilities so caddy can run as non-root with all caps dropped
# (we bind to 8080, not 80/443, so NET_BIND_SERVICE is unnecessary)
RUN setcap -r /usr/bin/caddy

COPY --from=builder /app/services/ui/dist /srv
COPY services/ui/Caddyfile /etc/caddy/Caddyfile

EXPOSE 8080
