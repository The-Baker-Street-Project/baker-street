# Stage 1: Build with pnpm (handles workspace:* deps)
FROM node:22-bookworm AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/extension-sdk/ packages/extension-sdk/
COPY examples/extension-browser/ examples/extension-browser/
RUN corepack enable && pnpm install --frozen-lockfile && pnpm -r build

# Prune to only the browser extension deps
RUN pnpm deploy --filter=@bakerst/extension-browser --prod --legacy /app/pruned

# Stage 2: Runtime with Playwright + agent-browser
FROM node:22-bookworm

# Use a shared browser path accessible by all users
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install Playwright's Chromium and all system dependencies
RUN npx -y playwright@1.58.2 install --with-deps chromium

# Install agent-browser CLI globally and download its managed browser
RUN npm install -g agent-browser@0.10.0 && agent-browser install

# Copy built app from builder
WORKDIR /app
COPY --from=builder /app/pruned/node_modules ./node_modules/
COPY --from=builder /app/examples/extension-browser/dist ./dist/
COPY --from=builder /app/pruned/package.json ./package.json

# Create non-root user and grant access to browser binaries
RUN groupadd -r pwuser && useradd -r -g pwuser -G audio,video pwuser \
    && mkdir -p /home/pwuser/.agent-browser && chown -R pwuser:pwuser /home/pwuser \
    && chmod -R o+rx /ms-playwright

# Switch to non-root user
USER pwuser
WORKDIR /home/pwuser

# Default: stdio transport (Docker/local use)
# For K8s/HTTP: override command in deployment spec
EXPOSE 8080
ENTRYPOINT ["node", "/app/dist/index.js"]
