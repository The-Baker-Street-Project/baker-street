FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY services/companion/package.json services/companion/
RUN corepack enable && pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY services/companion services/companion
RUN pnpm -r build

FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/services/companion/dist services/companion/dist
COPY --from=build /app/services/companion/package.json services/companion/
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
USER 1000
ENTRYPOINT ["node", "services/companion/dist/index.js"]
CMD ["/config/companion.json"]
