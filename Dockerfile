# Our Free Model 独立服务（服务器模式）
#
# 服务本体零 npm 依赖：镜像内只需要 Node 运行时与源码闭包。
# 服务器模式由 OFM_SERVER_MODE=1 开启：允许非回环绑定、
# 全路由强制 Bearer 密钥、管理页支持远程访问。
#
# 构建：  docker build -t our-free-model .
# 运行：  docker run -d -p 18900:18900 -v ofm-data:/data our-free-model
# 密钥：  启动日志会打印一次性管理链接；API Key 在 /data/settings.json 的 forwardKey。

FROM node:22-alpine

# dumb-init 保证 SIGTERM 能送达 node（docker stop 快速优雅退出）。
RUN apk add --no-cache dumb-init

WORKDIR /app

# 先只复制服务闭包（build-desktop.mjs 组装的同一份布局；直接从仓库源组装）
COPY src/ ./src/
COPY adapter/ ./adapter/
COPY packages/standalone/ ./packages/standalone/
COPY vendor/channel-pack/qoder-auth-wasm.wasm ./vendor/channel-pack/qoder-auth-wasm.wasm

# 运行期数据目录（挂卷点）：凭据、统计、密钥都在这里。
RUN mkdir -p /data && chown -R node:node /data /app

ENV NODE_ENV=production \
    OFM_SERVER_MODE=1 \
    OFM_HOME=/data \
    PORT=18900

USER node
EXPOSE 18900

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||18900)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "packages/standalone/cli.mjs", "--host", "0.0.0.0", "--port", "18900"]
