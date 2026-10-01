#!/usr/bin/env node
'use strict';

/**
 * twitchchattranslator 管理画面
 *
 *   起動:  manager.js が子プロセスとして起動する（単独で起動する場合は npm run web。bot の操作はできない）
 *
 * Twitch OAuth でログインし、運営者はチャンネルの登録・削除と共通の設定を、
 * 配信者は自分のチャンネルの設定・リスト・bot アカウント・Google Cloud のキーを扱う管理サーバーです。
 * 通常は manager.js の子プロセスとして起動され、bot の操作は IPC で管理プロセスに依頼します。
 */

const log4js = require('log4js');

const paths = require('../lib/paths');
const webConfig = require('./lib/webConfig');
const { createApp } = require('./app');
const { loadOperators } = require('./lib/operators');
const { createManagerClient, unavailableManager } = require('./lib/bot');

log4js.configure({
    appenders: {
        file: { type: 'dateFile', filename: 'logs/webui.log', pattern: 'yyyyMMdd', compress: true },
        console: { type: 'stdout' }
    },
    categories: { default: { appenders: ['file', 'console'], level: process.env.WEBUI_LOG_LEVEL || 'info' } }
});

const logger = log4js.getLogger('webui');
const config = webConfig.load();
// 管理プロセス（manager.js）の子プロセスとして起動されたときだけ IPC がある
const manager = typeof process.send === 'function' ? createManagerClient(process) : unavailableManager();
const app = createApp(config, logger, { manager });

const server = app.listen(config.port, config.host, () => {
    logger.info('管理画面を起動しました: http://' + config.host + ':' + config.port + '/');
    logger.info('プロジェクトディレクトリ: ' + paths.ROOT);
    logger.info('OAuth リダイレクト URI: ' + config.redirectUri);

    if (!manager.available()) {
        logger.warn('管理プロセスに接続されていません。bot の起動・停止などはできません（manager.js から起動してください）。');
    }

    logger.info('運営者: ' + (loadOperators(config.allowedUsers).join(', ') || 'なし') + '（配信者は登録済みのチャンネルのログイン名）');

    for (const warning of config.warnings) {
        logger.warn(warning);
    }

    for (const error of config.errors) {
        logger.error('[要設定] ' + error);
    }

    if (config.errors.length > 0) {
        logger.error('設定が完了するまでログインできません。config/webui.json を編集してから再起動してください。');
    }
});

function shutdown(signal) {
    logger.info(signal + ' を受信しました。管理画面を終了します...');

    server.close(() => {
        log4js.shutdown(() => process.exit(0));
    });

    setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
