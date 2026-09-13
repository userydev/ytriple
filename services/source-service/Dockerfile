FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/source-contract/package.json packages/source-contract/package.json
COPY services/source-service/package.json services/source-service/package.json
RUN npm ci --workspace @ytriple/source-contract --workspace @ytriple/source-service --include-workspace-root=false --ignore-scripts

COPY packages/source-contract packages/source-contract
COPY services/source-service services/source-service
RUN npm run build --workspace @ytriple/source-contract \
  && npm run build --workspace @ytriple/source-service \
  && npm prune --omit=dev --workspaces --include-workspace-root=false

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/source-contract/package.json packages/source-contract/package.json
COPY --from=build /app/packages/source-contract/dist packages/source-contract/dist
COPY --from=build /app/services/source-service/package.json services/source-service/package.json
COPY --from=build /app/services/source-service/dist services/source-service/dist
USER node
CMD ["node", "services/source-service/dist/main.js", "api"]
