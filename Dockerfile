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

# ログディレクトリ作成
RUN mkdir -p logs && \
    chown -R node:node /app/logs

# 非rootユーザーで実行
USER node

# 起動コマンド
CMD ["node", "twitchchattranslator.js"]
