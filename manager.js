#!/usr/bin/env node
'use strict';

/**
 * 管理プロセス（コンテナの PID 1。仕様書 9 節）
 *
 *   起動:  node manager.js
 *
 * - 登録済みのチャンネルごとに bot を子プロセスとして起動し、監視する（異常終了したら間隔をあけて起動し直す）
 * - 管理画面（web/server.js）も子プロセスとして常駐させる
 * - 状態を返す口（既定 0.0.0.0:3100、外には公開しない）: GET /healthz → 正常 200 / 異常 503（Docker の HEALTHCHECK 用）
 * - エモート一覧の定期更新（既定 6 時間おき、D17）。ホストの cron は使わない
 * - 古いログの削除（既定 30 日、D19）
 * - SIGTERM / SIGINT: bot をすべて止めてから管理画面を止め、終了する
 * - SIGHUP: チャンネルの一覧を読み直す
 */

const http = require('http');
const path = require('path');

const paths = require('./lib/paths');
const channels = require('./lib/channels');
const readiness = require('./lib/readiness');
const lists = require('./lib/lists');
const logRetention = require('./lib/logRetention');
const { Supervisor } = require('./lib/supervisor');
const { createServer: createIpcServer } = require('./lib/ipc');
const { readJson } = require('./lib/fileStore');

const BOT_PREFIX = 'bot:';
const WEB = 'web';

function botName(login) {
    return BOT_PREFIX + login;
}

/** bot の子プロセスの起動方法（チャンネルのディレクトリで、チャンネル固有の値を固定して起動する） */
function botSpec(login, options) {
    const p = paths.channel(login);

    // node-config の最優先の設定（NODE_CONFIG）で、チャンネルごとに必ず分けるべき値を固定する。
    // 共通の設定の pidFile は絶対パスなので、そのままだと全チャンネルの bot が同じファイルを取り合う。
    // GCP のキーも、ほかのチャンネルのキーを指すように書き換えられないよう、ここで決める。
    const override = {
        config: {
            pidFile: p.pidFile,
            googleKeyFile: p.googleKey,
            twitchChannel: login
        }
    };

    return {
        command: options.nodePath || process.execPath,
        // スクリプトはコードの場所（このファイルの隣）から探す。データの置き場所（paths.ROOT = TCT_ROOT）とは別
        args: [options.botScript || path.join(__dirname, 'twitchchattranslator.js')],
        cwd: p.root,
        env: Object.assign({}, process.env, options.botEnv || {}, {
            NODE_CONFIG_DIR: paths.CONFIG_DIR + path.delimiter + p.configDir,
            NODE_CONFIG: JSON.stringify(override),
            TCT_CHANNEL: login
        })
    };
}

function webSpec(options) {
    return {
        command: options.nodePath || process.execPath,
        args: [options.webScript || path.join(__dirname, 'web', 'server.js')],
        cwd: paths.ROOT,
        env: Object.assign({}, process.env, options.webEnv || {})
    };
}

/** チャンネルの設定（対象チャンネル名と配信者 ID）。エモート取得に使う */
function channelSettings(login) {
    const result = readJson(paths.channel(login).localConfig);
    const config = result.data && result.data.config ? result.data.config : {};

    return {
        twitchChannel: String(config.twitchChannel || login),
        twitchBroadcasterId: config.twitchBroadcasterId ? String(config.twitchBroadcasterId) : ''
    };
}

/**
 * @param {object} options
 * @param {object} [options.logger]           log4js 互換
 * @param {Supervisor} [options.supervisor]   テスト用に差し替え可能
 * @param {boolean} [options.startWeb=true]
 * @param {number} [options.healthPort=3100] 0 で無効
 * @param {string} [options.healthHost='0.0.0.0']
 * @param {number} [options.emoteIntervalMs=6h] 0 で無効
 * @param {number} [options.logRetentionDays=30]
 * @param {function} [options.fetchEmoteNames] lib/emotes.fetchEmoteNames の差し替え
 */
function createManager(options) {
    const opts = Object.assign({
        startWeb: true,
        healthPort: 3100,
        healthHost: '0.0.0.0',
        emoteIntervalMs: 6 * 60 * 60 * 1000,
        emoteFirstDelayMs: 60 * 1000,
        logRetentionDays: 30,
        logPruneIntervalMs: 24 * 60 * 60 * 1000
    }, options || {});

    const logger = opts.logger || console;
    const supervisor = opts.supervisor || new Supervisor();
    const fetchEmoteNames = opts.fetchEmoteNames || require('./lib/emotes').fetchEmoteNames;
    const startedAt = Date.now();
    const timers = [];
    let healthServer = null;
    let stopping = false;

    supervisor.on('start', (name, pid) => logger.info('起動しました: ' + name + ' (pid ' + pid + ')'));
    supervisor.on('exit', (name, code, signal) => {
        const message = '終了しました: ' + name + ' (code ' + code + ', signal ' + signal + ')';

        if (stopping || code === 0) {
            logger.info(message);
        } else {
            logger.warn(message + '。間隔をあけて起動し直します。');
        }
    });
    supervisor.on('output', (name, stream, line) => {
        (stream === 'stderr' ? logger.warn : logger.info).call(logger, '[' + name + '] ' + line);
    });

    /** 登録済みのチャンネルと実際の bot を突き合わせ、起動・停止する */
    async function reconcile() {
        if (stopping) { return; }

        const wanted = new Set();

        for (const channel of channels.list()) {
            const login = channel.login;
            const ready = readiness.checkChannel(login);

            if (channels.isEnabled(login) && ready.ready) {
                wanted.add(botName(login));
                supervisor.start(botName(login), botSpec(login, opts));
            }
        }

        const unwanted = supervisor.names().filter((name) => name.startsWith(BOT_PREFIX) && !wanted.has(name));

        await Promise.all(unwanted.map((name) => supervisor.remove(name)));
    }

    /** 状態のまとめ（状態を返す口と管理画面の両方で使う） */
    function status() {
        const bots = {};
        let healthy = true;

        for (const channel of channels.list()) {
            const login = channel.login;
            const enabled = channels.isEnabled(login);
            const ready = readiness.checkChannel(login);
            const proc = supervisor.status(botName(login));

            bots[login] = {
                enabled,
                ready: ready.ready,
                missing: ready.missing.map((item) => item.label),
                process: proc
            };

            // 動かすべき bot が動いていなければ異常
            if (enabled && ready.ready && (!proc || proc.state !== 'running')) {
                healthy = false;
            }
        }

        const web = opts.startWeb ? supervisor.status(WEB) : null;

        if (opts.startWeb && (!web || web.state !== 'running')) {
            healthy = false;
        }

        return {
            status: healthy ? 'ok' : 'error',
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
            web,
            bots
        };
    }

    /** 1 チャンネル分のエモート一覧を取得し直して、bot に読み直させる */
    async function refreshEmotes(login) {
        const settings = channelSettings(login);
        const result = await fetchEmoteNames({
            twitchChannel: settings.twitchChannel,
            twitchUserId: settings.twitchBroadcasterId
        });

        if (result.sources.every((source) => !source.ok)) {
            logger.warn('エモート取得: すべての取得元が失敗したため変更しません [' + login + '] ' + result.warnings.join(' / '));
            return { ok: false, warnings: result.warnings };
        }

        const written = lists.forChannel(login).write('emoticons', result.names);

        if (!written.ok) {
            logger.error('エモート一覧を保存できません [' + login + '] ' + written.errors.join(' / '));
            return { ok: false, errors: written.errors };
        }

        supervisor.signal(botName(login), 'SIGHUP');
        logger.info('エモート一覧を更新しました [' + login + '] ' + written.items.length + ' 件');

        return { ok: true, count: written.items.length, warnings: result.warnings };
    }

    async function refreshAllEmotes() {
        for (const channel of channels.list()) {
            try {
                await refreshEmotes(channel.login);
            } catch (err) {
                logger.error('エモート取得に失敗しました [' + channel.login + '] ' + err.message);
            }
        }
    }

    function pruneLogs() {
        const dirs = [path.join(paths.ROOT, 'logs')].concat(channels.list().map((c) => paths.channel(c.login).logDir));

        for (const dir of dirs) {
            const removed = logRetention.pruneDir(dir, opts.logRetentionDays);

            if (removed.length > 0) {
                logger.info('古いログを削除しました: ' + dir + ' ' + removed.join(', '));
            }
        }
    }

    function requireChannel(payload) {
        const login = channels.normalize(payload && payload.login);

        if (!channels.exists(login)) {
            throw new Error('登録されていないチャンネルです: ' + login);
        }

        return login;
    }

    // 管理画面（子プロセス）からの要求。権限の確認は管理画面側で済ませてから送ってくる
    const handlers = {
        'status': async () => status(),
        'channels.changed': async () => { await reconcile(); return status(); },
        'channel.start': async (payload) => {
            const login = requireChannel(payload);

            channels.setEnabled(login, true);
            await reconcile();
            return status().bots[login];
        },
        'channel.stop': async (payload) => {
            const login = requireChannel(payload);

            channels.setEnabled(login, false);
            await reconcile();
            return status().bots[login];
        },
        'channel.restart': async (payload) => {
            const login = requireChannel(payload);

            if (!(await supervisor.restart(botName(login)))) {
                await reconcile();
            }
            return status().bots[login];
        },
        'channel.reload': async (payload) => {
            const login = requireChannel(payload);

            return { sent: supervisor.signal(botName(login), 'SIGHUP') };
        },
        'emotes.refresh': async (payload) => refreshEmotes(requireChannel(payload))
    };

    const onIpc = createIpcServer(handlers, (name, msg) => supervisor.send(name, msg));

    supervisor.on('message', (name, msg) => {
        // 要求を受け付けるのは管理画面だけ
        if (name === WEB) { onIpc(name, msg); }
    });

    function startHealthServer() {
        if (!opts.healthPort) { return Promise.resolve(null); }

        healthServer = http.createServer((req, res) => {
            if (req.method !== 'GET' || req.url !== '/healthz') {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end('{"error":"not found"}');
            }

            const body = status();

            res.writeHead(body.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(body));
        });

        return new Promise((resolve) => {
            healthServer.listen(opts.healthPort, opts.healthHost, () => resolve(healthServer));
        });
    }

    async function start() {
        await startHealthServer();

        if (opts.startWeb) {
            supervisor.start(WEB, webSpec(opts));
        }

        await reconcile();

        if (opts.emoteIntervalMs) {
            const first = setTimeout(() => {
                refreshAllEmotes();
                const every = setInterval(refreshAllEmotes, opts.emoteIntervalMs);

                every.unref();
                timers.push(every);
            }, opts.emoteFirstDelayMs);

            first.unref();
            timers.push(first);
        }

        if (opts.logRetentionDays && opts.logPruneIntervalMs) {
            pruneLogs();
            const prune = setInterval(pruneLogs, opts.logPruneIntervalMs);

            prune.unref();
            timers.push(prune);
        }

        logger.info('管理プロセスを起動しました（チャンネル ' + channels.list().length + ' 件）');
    }

    /** bot をすべて止めてから管理画面を止める（仕様書 9 節） */
    async function stop() {
        if (stopping) { return; }

        stopping = true;

        for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }

        await supervisor.stopMatching((name) => name.startsWith(BOT_PREFIX));
        await supervisor.stopMatching((name) => name === WEB);

        if (healthServer) {
            await new Promise((resolve) => healthServer.close(() => resolve()));
        }

        logger.info('管理プロセスを終了します');
    }

    return { start, stop, reconcile, status, refreshEmotes, pruneLogs, handlers, supervisor, botSpec: (login) => botSpec(login, opts) };
}

module.exports = { createManager, botName, BOT_PREFIX, WEB };

if (require.main === module) {
    const log4js = require('log4js');

    log4js.configure({
        appenders: {
            file: { type: 'dateFile', filename: path.join(paths.ROOT, 'logs', 'manager.log'), pattern: 'yyyyMMdd', compress: true },
            console: { type: 'stdout' }
        },
        categories: { default: { appenders: ['file', 'console'], level: process.env.MANAGER_LOG_LEVEL || 'info' } }
    });

    const logger = log4js.getLogger('manager');
    const manager = createManager({
        logger,
        healthPort: Number(process.env.MANAGER_HEALTH_PORT || 3100),
        healthHost: process.env.MANAGER_HEALTH_HOST || '0.0.0.0'
    });

    let exiting = false;

    async function shutdown(signal) {
        if (exiting) { return; }

        exiting = true;
        logger.info(signal + ' を受信しました。子プロセスを止めて終了します...');

        try {
            await manager.stop();
        } finally {
            log4js.shutdown(() => process.exit(0));
        }
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGHUP', () => {
        logger.info('SIGHUP を受信しました。チャンネルの一覧を読み直します');
        manager.reconcile().catch((err) => logger.error('チャンネルの読み直しに失敗しました: ' + err.message));
    });

    manager.start().catch((err) => {
        logger.error('管理プロセスを起動できません: ' + err.stack);
        log4js.shutdown(() => process.exit(1));
    });
}
