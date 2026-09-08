FROM node:24-alpine

WORKDIR /app

COPY apps/companion-relay/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

COPY apps/companion-relay/src/server.ts ./src/server.ts

ENV NODE_ENV=production \
    COMPANION_RELAY_HOST=0.0.0.0 \
    COMPANION_RELAY_PORT=8876

USER node
EXPOSE 8876

CMD ["node", "--experimental-strip-types", "src/server.ts"]
