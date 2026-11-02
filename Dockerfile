# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -r /run/secrets/proxy_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --no-audit --no-fund; \
    else npm ci --no-audit --no-fund; fi
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p /data && chown node:node /data
ENV OMI_BIND=0.0.0.0 OMI_PORT=8080 OMI_FORUM_DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]
USER node
CMD ["node", "server/index.ts"]
