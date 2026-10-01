# Node.js 20 LTS
FROM node:20-alpine

WORKDIR /app

# 依存関係ファイルをコピー
COPY package*.json ./

# 本番依存関係のみインストール（package-lock.jsonを利用）
RUN npm ci --omit=dev && \
    npm cache clean --force

# アプリケーションコードをコピー
COPY --chown=node:node . .

# ログ・チャンネル・操作の記録などの置き場所（本番ではリポジトリごと /app にマウントするので、そちらが使われる）
RUN mkdir -p logs channels data config && \
    chown -R node:node /app/logs /app/channels /app/data /app/config

# 非rootユーザーで実行（uid 1000。ホストのリポジトリの所有者と合わせる）
USER node

# 3000: 管理画面、3200: EventSub の受信口（どちらもリバースプロキシから転送する）
# 3100: 状態の口（/healthz。コンテナの中と同じネットワークからだけ使う。外へは公開しない）
EXPOSE 3000 3200

# 管理プロセスの状態の口が 200 を返せば正常（bot の異常終了・管理画面の停止で 503 になる）
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3100/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# 管理プロセス（PID 1）がチャンネルごとの bot と管理画面を起動・監視する。
# SIGTERM で子プロセスを順に止めてから終了するので、停止の猶予（stop_grace_period）は 30 秒程度にする
CMD ["node", "manager.js"]
