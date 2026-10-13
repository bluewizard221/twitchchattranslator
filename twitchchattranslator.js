#!/usr/bin/env node
'use strict';

/**
 * 翻訳 bot（チャンネルごとに 1 プロセス。仕様書 8 節）
 *
 * 管理プロセス（manager.js）がチャンネルのディレクトリで起動する。単独では起動しない。
 *   - EventSub のイベントは管理プロセスから IPC で受け取る（IRC は使わない）
 *   - 翻訳は Helix の Send Chat Message で投稿する（App Access Token。IRC での代替投稿はしない）
 *   - SIGHUP: リストを読み直す / SIGTERM・SIGINT: 終了する
 *
 * 設定（node-config。管理プロセスが NODE_CONFIG_DIR と NODE_CONFIG を渡す）:
 *   共通: twitchClientId, twitchClientSecret
 *   チャンネル: twitchBroadcasterId, coolDownCount, dailyCharLimit（0 は上限なし）
 *   管理プロセスが固定する値: twitchChannel, googleKeyFile, pidFile
 */

const fs = require('fs');
const confFile = require('config');
const log4js = require('log4js');

const paths = require('./lib/paths');
const lists = require('./lib/lists');
const sharedConfig = require('./lib/sharedConfig');
const { createTwitchApi } = require('./lib/twitchApi');
const { createBot } = require('./lib/bot/runtime');
const { Usage } = require('./lib/bot/usage');
const { createClient } = require('./lib/ipc');

log4js.configure({
    appenders: { system: { type: 'dateFile', filename: 'logs/twitchchattranslator.log', pattern: 'yyyyMMdd', compress: true } },
    categories: { default: { appenders: ['system'], level: process.env.BOT_LOG_LEVEL || 'info' } }
});

const logger = log4js.getLogger('system');

function fail(message, code) {
    logger.error(message);
    log4js.shutdown(() => process.exit(code));
}

const login = process.env.TCT_CHANNEL;
const config = confFile.has('config') ? confFile.get('config') : {};
const shared = sharedConfig.load();
const clientId = shared.twitchClientId || config.twitchClientId;
const clientSecret = shared.twitchClientSecret || config.twitchClientSecret;

if (!paths.isValidLogin(login)) {
    fail('TCT_CHANNEL が設定されていません。bot は管理プロセス（manager.js）から起動してください。', 2);
} else if (!clientId || !clientSecret) {
    fail('Twitch アプリの Client ID / Client Secret が設定されていません（共通の設定）。', 3);
} else if (!config.twitchBroadcasterId) {
    fail('配信者の ID（twitchBroadcasterId）が設定されていません。', 4);
} else if (!config.googleKeyFile || !fs.existsSync(config.googleKeyFile)) {
    fail('Google Cloud のキーがありません: ' + config.googleKeyFile, 5);
} else {
    run();
}

function run() {
    if (config.pidFile) {
        try {
            fs.writeFileSync(config.pidFile, String(process.pid));
        } catch (err) {
            logger.warn('pid ファイルを書けません: ' + err.message);
        }
    }

    const api = createTwitchApi({ clientId, clientSecret });
    const { Translate } = require('@google-cloud/translate').v2;
    const translate = new Translate({ keyFilename: config.googleKeyFile });

    const bot = createBot({
        config: {
            broadcasterId: String(config.twitchBroadcasterId),
            coolDownCount: Number(config.coolDownCount) || 5,
            dailyCharLimit: Number(config.dailyCharLimit) || 0
        },
        tokensFile: paths.channel(login).botTokens,
        api,
        translate,
        lists: lists.forChannel(login),
        usage: new Usage(login),
        logger
    });

    process.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') { return; }

        if (msg.type === 'app-token' && msg.token) {
            api.setAppToken(msg.token, msg.expiresAt);
        } else if (msg.type === 'eventsub') {
            bot.handleEvent(msg.subscriptionType, msg.event || {}).catch((err) => {
                logger.error('イベントの処理に失敗しました ' + msg.subscriptionType + ': ' + err.message);
            });
        }
    });

    // 管理プロセスから App Access Token を受け取る（受け取れなければ自分で取得する）
    const ipc = createClient(process, { timeoutMs: 5000 });

    if (ipc.available()) {
        ipc.request('app-token').then((info) => {
            if (info && info.token) { api.setAppToken(info.token, info.expiresAt); }
        }).catch((err) => logger.warn('管理プロセスから App Access Token を受け取れません（自分で取得します）: ' + err.message));
    }

    setInterval(() => bot.cleanupMessageMap(), 30 * 60 * 1000);

    process.on('SIGHUP', () => {
        logger.info('SIGHUP caught. refreshing database...');
        bot.reloadLists();
    });

    const shutdown = (signal) => {
        logger.info(signal + ' caught. shutting down...');
        log4js.shutdown(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    bot.start().then(() => {
        logger.info('翻訳 bot を起動しました: ' + login + '（EventSub、bot ' + bot.tokens().login + '）');
    }).catch((err) => fail('起動に失敗しました: ' + err.message, 1));
}
