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

# --port 18900 与桌面端默认一致；--data-dir 持久化账号/配置
CMD ["node", "packages/standalone/cli.mjs", "--port", "18900", "--data-dir", "/data"]
