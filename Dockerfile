# better-sqlite3 is a native module. Building it in a stage that has a
# toolchain means the image works whether or not a prebuilt binary exists for
# this platform, and the compiler never ships in the final image.
FROM node:22-bookworm-slim AS deps

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DOWNLOAD_DIR=/downloads \
    TORRENTD_DATA=/data \
    TORRENT_PORT=6881 \
    DHT_PORT=6882

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /downloads /data && chown -R node:node /downloads /data /app
USER node

EXPOSE 8080
EXPOSE 6881/tcp
EXPOSE 6882/udp

# Every route sits behind Basic auth, so a 401 is a perfectly healthy answer —
# it proves the server is up and authenticating. Only 5xx or a refused
# connection means trouble.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/state').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
