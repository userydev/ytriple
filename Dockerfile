FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY scripts/build-server.mjs ./scripts/build-server.mjs
RUN npm run server:build
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production YTRIPLE_HOST=0.0.0.0 YTRIPLE_DATA_DIR=/data PORT=4317
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir /data && chown node:node /data
COPY --from=build /app/dist/server ./dist/server
USER node
VOLUME /data
EXPOSE 4317
CMD ["node", "dist/server/index.mjs"]
