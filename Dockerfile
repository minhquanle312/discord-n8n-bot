FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN apk add --no-cache wget && npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3010/healthz || exit 1

CMD ["node", "index.js"]
