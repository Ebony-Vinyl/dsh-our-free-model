FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    OFM_ALLOW_NON_LOOPBACK=1

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /ofm-data && chown -R node:node /app /ofm-data

VOLUME ["/ofm-data"]
EXPOSE 18900

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:18900/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["npm", "run", "start:standalone", "--", "--host", "0.0.0.0", "--port", "18900", "--data-dir", "/ofm-data"]
