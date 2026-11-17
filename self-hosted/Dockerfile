FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mkdir /data && chown node:node /data
COPY backend ./backend
COPY shared ./shared
COPY web ./web
COPY generated ./generated
COPY self-hosted/server.mjs ./self-hosted/server.mjs
USER node
ENV DATA_DIR=/data LISTEN_HOST=0.0.0.0 PORT=8788
CMD ["node","self-hosted/server.mjs"]
