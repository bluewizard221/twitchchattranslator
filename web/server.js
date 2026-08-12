#!/usr/bin/env node
'use strict';

/**
 * twitchchattranslator 管理画面
 *
 *   起動:  npm run web
 *
 * Twitch OAuth でログインし、設定ファイル・各種リスト・Google Cloud のキーを
 * ブラウザから編集するための管理サーバーです。
 */

const log4js = require('log4js');

const paths = require('../lib/paths');
const webConfig = require('./lib/webConfig');
const { createApp } = require('./app');

log4js.configure({
    appenders: {
        file: { type: 'dateFile', filename: 'logs/webui.log', pattern: 'yyyyMMdd', compress: true },
        console: { type: 'stdout' }
    },
    categories: { default: { appenders: ['file', 'console'], level: process.env.WEBUI_LOG_LEVEL || 'info' } }
});

const logger = log4js.getLogger('webui');
const config = webConfig.load();
const app = createApp(config, logger);

const server = app.listen(config.port, config.host, () => {
    logger.info('管理画面を起動しました: http://' + config.host + ':' + config.port + '/');
    logger.info('プロジェクトディレクトリ: ' + paths.ROOT);
    logger.info('OAuth リダイレクト URI: ' + config.redirectUri);

    if (config.usingBotCredentials) {
        logger.info('Twitch アプリの認証情報は bot 設定（config/default.json など）から流用しています。');
    }

    logger.info('ログインを許可しているユーザー: ' + (config.allowedUsers.join(', ') || 'なし'));

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
