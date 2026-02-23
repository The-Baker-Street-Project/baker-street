FROM node:22-slim AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/extension-sdk/ packages/extension-sdk/
COPY examples/extension-hello-world/ examples/extension-hello-world/
RUN corepack enable && pnpm install --frozen-lockfile && pnpm -r build

# Prune to only the hello-world deps
RUN pnpm deploy --filter=@bakerst/extension-hello-world --prod --legacy /app/pruned

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/pruned/node_modules ./node_modules/
COPY --from=builder /app/examples/extension-hello-world/dist ./dist/
COPY --from=builder /app/pruned/package.json ./package.json
USER 1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
