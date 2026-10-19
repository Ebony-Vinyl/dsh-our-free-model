# Our Free Model — 独立本地服务 (standalone) 容器镜像
#
# 重要：standalone 服务在代码层仅绑定 loopback 地址
# （packages/standalone/service.mjs:112 限制 isLoopbackHost），
# 因此本镜像在容器内只监听 127.0.0.1:18900。
# 要从宿主机访问，请用 host 网络模式（见 docker-compose.yml，仅 Linux 支持），
# 或在前方另起反向代理。不要把 --host 0.0.0.0 传进去，服务会直接抛错退出。
FROM node:22-bookworm-slim

WORKDIR /app

# 先装依赖以利用构建缓存
COPY package.json package-lock.json ./
COPY packages/standalone/package.json packages/standalone/package-lock.json ./packages/standalone/
RUN npm ci --no-audit --no-fund \
 && npm --prefix packages/standalone ci --no-audit --no-fund

# 复制完整仓库（standalone 需从完整仓库运行，依赖根目录 src/、client.js 等）
COPY . .

# 构建独立端 web 资源
RUN node scripts/build-standalone-ui.mjs

VOLUME ["/data"]
EXPOSE 18900

# 默认仅本机(127.0.0.1)。NAS / 局域网部署：设环境变量 OFM_ALLOW_NONLOOPBACK=1 且 OFM_BIND=0.0.0.0
# （代码默认仍只绑 loopback，需显式开启，避免误暴露到不可信网络）。
CMD ["sh", "-c", "node packages/standalone/cli.mjs --port 18900 --bind ${OFM_BIND:-127.0.0.1} --data-dir /data"]
