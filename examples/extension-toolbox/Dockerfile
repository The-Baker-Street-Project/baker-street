FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/extension-sdk/ packages/extension-sdk/
COPY examples/extension-toolbox/ examples/extension-toolbox/
RUN corepack enable && pnpm install --frozen-lockfile && pnpm -r build

# Prune to only the toolbox extension deps
RUN pnpm deploy --filter=@bakerst/extension-toolbox --prod --legacy /app/pruned

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/pruned/node_modules ./node_modules/
COPY --from=builder /app/examples/extension-toolbox/dist ./dist/
COPY --from=builder /app/pruned/package.json ./package.json
USER 1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
