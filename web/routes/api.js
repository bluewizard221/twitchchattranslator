'use strict';

const express = require('express');
const paths = require('../../lib/paths');
const channels = require('../../lib/channels');
const lists = require('../../lib/lists');
const audit = require('../../lib/audit');
const usage = require('../../lib/bot/usage');
const readiness = require('../../lib/readiness');
const configStore = require('../lib/configStore');
const configSchema = require('../lib/configSchema');
const googleKey = require('../lib/googleKey');
const botConnection = require('../lib/botConnection');
const channelOps = require('../lib/channelOps');
const logs = require('../lib/logs');
const { loadOperators } = require('../lib/operators');
const { readJson, writeJsonAtomic } = require('../../lib/fileStore');
const { requireCsrf } = require('../middleware/auth');

const FORBIDDEN = 'このチャンネルが見つからないか、操作する権限がありません。';

/**
 * 管理画面の API（仕様書 4・10・11 節）。
 *
 * 権限の確認はすべて guard() / guardChannel() で行い、ルートの中では判定しない。
 * チャンネルを対象にする API は /api/channels/:login/... の形に統一し、
 * 存在しないチャンネルと権限のないチャンネルは同じ 403 を返す（他人のチャンネルの有無を探らせない）。
 *
 * @param {object} deps { roles, manager, sessionStore, revokeToken(token) => Promise<boolean> }
 */
function createApiRouter(config, logger, deps) {
    const router = express.Router();
    const { roles, manager } = deps;

    router.use(requireCsrf);

    /** チャンネルを問わない操作（運営者向け） */
    function guard(action) {
        return (req, res, next) => {
            if (!roles.can(req.session.user, action)) {
                return res.status(403).json({ error: 'この操作は運営者だけが行えます。', code: 'forbidden' });
            }
            next();
        };
    }

    /** チャンネルを対象にする操作。req.channel に正規化したログイン名を入れる */
    function guardChannel(action) {
        return (req, res, next) => {
            const login = channels.normalize(req.params.login);

            if (!roles.can(req.session.user, action, login)) {
                return res.status(403).json({ error: FORBIDDEN, code: 'forbidden' });
            }

            req.channel = login;
            next();
        };
    }

    function actor(req) {
        return channels.normalize(req.session.user.login);
    }

    async function ask(action, payload) {
        return channelOps.notifyManager(manager, action, payload, logger);
    }

    // ------------------------------------------------------------------
    // セッション情報
    // ------------------------------------------------------------------
    router.get('/session', (req, res) => {
        const role = roles.resolve(req.session.user);
        const flash = req.session.flash || null;

        req.session.flash = null;

        res.json({
            user: req.session.user,
            csrfToken: req.session.csrfToken,
            role: { login: role.login, isOperator: role.isOperator, channel: role.channel },
            managerAvailable: manager.available(),
            flash
        });
    });

    // ------------------------------------------------------------------
    // チャンネルの一覧・登録・削除（運営者）
    // ------------------------------------------------------------------
    router.get('/channels', guard('channels.list'), async (req, res) => {
        const state = await ask('status');
        const bots = state.ok && state.result ? state.result.bots || {} : {};

        res.json({
            managerAvailable: state.ok,
            eventsub: state.ok && state.result ? state.result.eventsub : null,
            channels: channels.list().map((meta) => summary(meta, bots[meta.login]))
        });
    });

    router.post('/channels', guard('channels.register'), async (req, res) => {
        const login = req.body && req.body.login;
        const result = await channelOps.register(login, actor(req), { manager, logger });

        if (!result.ok) {
            return res.status(400).json({ error: result.error });
        }

        logger.info('チャンネルを登録しました [' + actor(req) + '] ' + result.channel.login);
        res.json(result);
    });

    router.delete('/channels/:login', guard('channels.delete'), async (req, res) => {
        const login = channels.normalize(req.params.login);
        const confirm = channels.normalize(req.body && req.body.confirm);

        // 取り消せない操作なので、ログイン名をもう一度入力させる
        if (confirm !== login) {
            return res.status(400).json({ error: '確認のため、削除するチャンネルのログイン名を入力してください。' });
        }

        const result = await channelOps.remove(login, actor(req), {
            manager,
            revokeToken: deps.revokeToken,
            sessionStore: deps.sessionStore,
            logger
        });

        if (!result.ok) {
            return res.status(404).json({ error: result.error });
        }

        logger.info('チャンネルを削除しました [' + actor(req) + '] ' + login + ' ' +
            result.steps.map((s) => s.step + ':' + (s.ok ? 'ok' : 'failed')).join(' '));
        res.json(result);
    });

    // ------------------------------------------------------------------
    // チャンネルの状態と起動・停止
    // ------------------------------------------------------------------
    router.get('/channels/:login', guardChannel('channel.status'), async (req, res) => {
        const login = req.channel;
        const state = await ask('status');
        const bots = state.ok && state.result ? state.result.bots || {} : {};
        const body = summary(channels.get(login), bots[login]);

        body.managerAvailable = state.ok;

        // 配信者本人だけが見られる情報（運営者は代わりに操作しないので見せない: D18）
        if (roles.can(req.session.user, 'channel.secrets', login)) {
            const snapshot = configStore.channelSnapshot(login);
            const meta = channels.get(login);

            body.owner = {
                broadcasterId: snapshot.twitchBroadcasterId,
                channelBotGrantedAt: meta.channelBotGrantedAt || null,
                bot: botConnection.status(login),
                googleKey: googleKey.statusForChannel(login),
                usage: usageOf(login, snapshot)
            };
        }

        res.json(body);
    });

    for (const op of ['start', 'stop', 'restart']) {
        router.post('/channels/:login/' + op, guardChannel('channel.control'), async (req, res) => {
            const result = await ask('channel.' + op, { login: req.channel });

            if (!result.ok) {
                return res.status(503).json({ error: '管理プロセスに依頼できませんでした: ' + result.error });
            }

            audit.append({ actor: actor(req), action: 'channel.' + op, channel: req.channel });
            logger.info('bot を操作しました [' + actor(req) + '] ' + req.channel + ': ' + op);
            res.json({ ok: true, process: result.result || null });
        });
    }

    // ------------------------------------------------------------------
    // チャンネルの設定（配信者本人）
    // ------------------------------------------------------------------
    router.get('/channels/:login/config', guardChannel('channel.config'), (req, res) => {
        const snapshot = configStore.channelSnapshot(req.channel);

        res.json({
            fields: configSchema.publicFields(configSchema.CHANNEL_FIELDS),
            values: snapshot.values,
            twitchChannel: snapshot.twitchChannel,
            twitchBroadcasterId: snapshot.twitchBroadcasterId,
            meta: configStore.meta(paths.channel(req.channel).localConfig)
        });
    });

    router.put('/channels/:login/config', guardChannel('channel.config'), async (req, res) => {
        const result = configStore.saveChannel(req.channel, req.body && req.body.values);

        if (!result.ok) {
            return res.status(400).json({ error: '入力内容を確認してください。', fieldErrors: result.errors });
        }

        audit.append({ actor: actor(req), action: 'config.update', channel: req.channel, detail: { keys: result.saved } });
        logger.info('チャンネルの設定を更新しました [' + actor(req) + '] ' + req.channel + ' 項目: ' + (result.saved.join(', ') || 'なし'));

        // 設定は起動時に読むので、動いていれば再起動して反映する
        const restarted = result.saved.length > 0 ? await restartIfRunning(req.channel) : null;

        res.json({
            ok: true,
            saved: result.saved,
            restarted,
            values: configStore.channelSnapshot(req.channel).values
        });
    });

    // ------------------------------------------------------------------
    // リスト（配信者本人）
    // ------------------------------------------------------------------
    router.get('/channels/:login/lists', guardChannel('channel.lists'), (req, res) => {
        const store = lists.forChannel(req.channel);
        const result = {};

        for (const def of store.describeAll()) {
            const data = store.read(def.id);

            result[def.id] = {
                label: def.label,
                help: def.help,
                placeholder: def.placeholder,
                items: data.items,
                error: data.error,
                updatedAt: data.updatedAt
            };
        }

        res.json(result);
    });

    router.put('/channels/:login/lists/:id', guardChannel('channel.lists'), async (req, res) => {
        const store = lists.forChannel(req.channel);
        const id = req.params.id;

        if (!store.getList(id)) {
            return res.status(404).json({ error: '不明なリストです。' });
        }

        const result = store.write(id, req.body && req.body.items);

        if (!result.ok) {
            return res.status(400).json({ error: '入力内容を確認してください。', errors: result.errors });
        }

        audit.append({ actor: actor(req), action: 'lists.update', channel: req.channel, detail: { list: id, count: result.items.length } });
        logger.info('リストを更新しました [' + actor(req) + '] ' + req.channel + ' ' + id + ': ' + result.items.length + ' 件');

        // bot にリストを読み直させる（止まっていれば何もしない）
        const reloaded = await ask('channel.reload', { login: req.channel });

        res.json({
            ok: true,
            items: result.items,
            removedDuplicates: result.removedDuplicates,
            updatedAt: store.read(id).updatedAt,
            reloaded: reloaded.ok && reloaded.result ? !!reloaded.result.sent : false
        });
    });

    router.post('/channels/:login/emotes/refresh', guardChannel('channel.lists'), async (req, res) => {
        const result = await ask('emotes.refresh', { login: req.channel });

        if (!result.ok) {
            return res.status(503).json({ error: '管理プロセスに依頼できませんでした: ' + result.error });
        }
        if (!result.result || !result.result.ok) {
            const detail = result.result ? (result.result.warnings || result.result.errors || []) : [];

            return res.status(502).json({ error: 'エモートを取得できませんでした。エモート一覧は変更していません。', errors: detail });
        }

        audit.append({ actor: actor(req), action: 'emotes.refresh', channel: req.channel, detail: { count: result.result.count } });
        res.json({ ok: true, count: result.result.count, warnings: result.result.warnings || [] });
    });

    // ------------------------------------------------------------------
    // Google Cloud のキー（配信者本人。書き込み専用）
    // ------------------------------------------------------------------
    router.get('/channels/:login/google-key', guardChannel('channel.secrets'), (req, res) => {
        res.json({ status: googleKey.statusForChannel(req.channel), maxBytes: googleKey.MAX_KEY_BYTES });
    });

    router.post('/channels/:login/google-key', guardChannel('channel.secrets'), async (req, res) => {
        const result = googleKey.saveForChannel(req.channel, req.body && req.body.content);

        if (!result.ok) {
            return res.status(400).json({ error: result.error, warnings: result.warnings });
        }

        // 秘密鍵は記録しない。どのサービスアカウントかだけを残す
        audit.append({ actor: actor(req), action: 'googleKey.upload', channel: req.channel, detail: { projectId: result.projectId, clientEmail: result.clientEmail } });
        logger.info('Google Cloud のキーを更新しました [' + actor(req) + '] ' + req.channel + ' (project: ' + result.projectId + ')');

        // 準備がそろえば起動され、差し替えなら新しいキーで動かし直す
        await ask('channels.changed');
        const restarted = await restartIfRunning(req.channel);

        res.json({
            ok: true,
            projectId: result.projectId,
            clientEmail: result.clientEmail,
            warnings: result.warnings,
            restarted,
            status: googleKey.statusForChannel(req.channel)
        });
    });

    router.delete('/channels/:login/google-key', guardChannel('channel.secrets'), async (req, res) => {
        const removed = googleKey.removeForChannel(req.channel);

        if (removed) {
            audit.append({ actor: actor(req), action: 'googleKey.delete', channel: req.channel });
            logger.info('Google Cloud のキーを削除しました [' + actor(req) + '] ' + req.channel);
        }

        // キーがなくなったので bot は止まる
        await ask('channels.changed');

        res.json({
            ok: true,
            removed,
            notice: 'ファイルは削除しましたが、GCP 側ではキーが有効なままです。Google Cloud のコンソールでキーを削除してください。'
        });
    });

    // ------------------------------------------------------------------
    // bot アカウント（配信者本人）。接続は /auth/bot/:login の OAuth で行う
    // ------------------------------------------------------------------
    router.get('/channels/:login/bot', guardChannel('channel.secrets'), (req, res) => {
        res.json({ status: botConnection.status(req.channel), requiredScopes: botConnection.REQUIRED_SCOPES });
    });

    router.delete('/channels/:login/bot', guardChannel('channel.secrets'), async (req, res) => {
        const tokens = botConnection.readTokens(req.channel);
        let revoked = null;

        if (tokens) {
            const results = await Promise.all([tokens.accessToken, tokens.refreshToken].filter(Boolean).map((t) => deps.revokeToken(t)));

            revoked = results.every(Boolean);
        }

        const removed = botConnection.remove(req.channel);

        if (removed) {
            audit.append({ actor: actor(req), action: 'bot.disconnect', channel: req.channel, detail: { botLogin: tokens ? tokens.login : null, revoked } });
            logger.info('bot アカウントの接続を解除しました [' + actor(req) + '] ' + req.channel);
        }

        // トークンがなくなったので bot は止まり、購読も外れる
        await ask('channels.changed');

        res.json({ ok: true, removed, revoked });
    });

    // ------------------------------------------------------------------
    // 使用量（配信者本人）
    // ------------------------------------------------------------------
    router.get('/channels/:login/usage', guardChannel('channel.usage'), (req, res) => {
        res.json(usageOf(req.channel, configStore.channelSnapshot(req.channel)));
    });

    // ------------------------------------------------------------------
    // ログ（チャンネル: 本人と運営者、システム: 運営者）
    // ------------------------------------------------------------------
    const logLimits = { defaultLines: logs.DEFAULT_LINES, maxLines: logs.MAX_LINES };

    router.get('/channels/:login/logs', guardChannel('channel.logs'), (req, res) => {
        res.json(Object.assign({ logs: logs.describe({ type: 'channel', login: req.channel }) }, logLimits));
    });

    router.get('/channels/:login/logs/:id', guardChannel('channel.logs'), (req, res) => {
        const result = logs.tail({ type: 'channel', login: req.channel }, req.params.id, { lines: req.query.lines, level: req.query.level });

        if (!result) { return res.status(404).json({ error: '不明なログです。' }); }
        res.json(result);
    });

    router.get('/system/logs', guard('system.logs'), (req, res) => {
        res.json(Object.assign({ logs: logs.describe({ type: 'system' }) }, logLimits));
    });

    router.get('/system/logs/:id', guard('system.logs'), (req, res) => {
        const result = logs.tail({ type: 'system' }, req.params.id, { lines: req.query.lines, level: req.query.level });

        if (!result) { return res.status(404).json({ error: '不明なログです。' }); }
        res.json(result);
    });

    // ------------------------------------------------------------------
    // 操作の記録（チャンネル: 本人と運営者、全体: 運営者）
    // ------------------------------------------------------------------
    router.get('/channels/:login/audit', guardChannel('channel.audit'), (req, res) => {
        res.json({ entries: audit.read({ channel: req.channel, limit: req.query.limit }) });
    });

    router.get('/audit', guard('audit.all'), (req, res) => {
        res.json({ entries: audit.read({ limit: req.query.limit }) });
    });

    // ------------------------------------------------------------------
    // 共通の設定（運営者）
    // ------------------------------------------------------------------
    const RESTART_NOTICE = '共通の設定は起動時に読み込むため、反映にはコンテナの再起動が必要です。';

    router.get('/shared/config', guard('shared.config'), (req, res) => {
        res.json({
            fields: configSchema.publicFields(configSchema.SHARED_FIELDS),
            values: configStore.sharedSnapshot().values,
            meta: configStore.meta(paths.LOCAL_CONFIG),
            notice: RESTART_NOTICE
        });
    });

    router.put('/shared/config', guard('shared.config'), (req, res) => {
        const result = configStore.saveShared(req.body && req.body.values);

        if (!result.ok) {
            return res.status(400).json({ error: '入力内容を確認してください。', fieldErrors: result.errors });
        }

        audit.append({ actor: actor(req), action: 'shared.config', detail: { keys: result.saved } });
        logger.info('共通の設定を更新しました [' + actor(req) + '] 項目: ' + (result.saved.join(', ') || 'なし'));

        res.json({ ok: true, saved: result.saved, values: configStore.sharedSnapshot().values, notice: RESTART_NOTICE });
    });

    router.get('/shared/operators', guard('shared.config'), (req, res) => {
        res.json(operatorsSnapshot(config));
    });

    router.put('/shared/operators', guard('shared.config'), (req, res) => {
        const raw = req.body && req.body.operators;

        if (!Array.isArray(raw)) {
            return res.status(400).json({ error: '運営者の一覧を配列で送ってください。' });
        }

        const names = Array.from(new Set(raw.map((name) => channels.normalize(name)).filter((name) => name !== '')));
        const invalid = names.filter((name) => !paths.isValidLogin(name));

        if (invalid.length > 0) {
            return res.status(400).json({ error: 'Twitch のログイン名の形式が正しくありません: ' + invalid.join(', ') });
        }

        const before = operatorsSnapshot(config);
        const effective = new Set(names.concat(before.fromEnv, before.fromLegacy));

        // 自分を外すと、その場で管理画面から締め出される
        if (!effective.has(actor(req))) {
            return res.status(400).json({ error: '自分自身（' + actor(req) + '）を運営者の一覧から外すことはできません。' });
        }

        const current = readJson(paths.OPERATORS);
        const root = current.data && typeof current.data === 'object' && !Array.isArray(current.data) ? current.data : {};

        writeJsonAtomic(paths.OPERATORS, Object.assign({}, root, { operators: names }), { mode: 0o640 });

        audit.append({
            actor: actor(req),
            action: 'operators.update',
            detail: {
                added: names.filter((n) => before.fromFile.indexOf(n) === -1),
                removed: before.fromFile.filter((n) => names.indexOf(n) === -1)
            }
        });
        logger.info('運営者の一覧を更新しました [' + actor(req) + '] ' + names.join(', '));

        res.json(Object.assign({ ok: true }, operatorsSnapshot(config)));
    });

    /** 設定が保存されたら、動いている bot を再起動して反映する */
    async function restartIfRunning(login) {
        const state = await ask('status');
        const bot = state.ok && state.result && state.result.bots ? state.result.bots[login] : null;

        if (!bot || !bot.process || bot.process.state !== 'running') { return false; }

        const restarted = await ask('channel.restart', { login });

        return restarted.ok;
    }

    return router;
}

/** 一覧と状態の表示用（秘密の値を含めない） */
function summary(meta, bot) {
    const ready = readiness.checkChannel(meta.login);

    return {
        login: meta.login,
        createdAt: meta.createdAt,
        createdBy: meta.createdBy || null,
        enabled: channels.isEnabled(meta.login),
        ready: ready.ready,
        missing: ready.missing,
        process: bot && bot.process ? bot.process : null
    };
}

function usageOf(login, snapshot) {
    const record = usage.read(login);
    const limit = Number(snapshot.values.dailyCharLimit.value) || 0;

    return {
        today: record.today(),
        month: record.month(),
        dailyLimit: limit,
        exceeded: record.exceeded(limit)
    };
}

function operatorsSnapshot(config) {
    const file = readJson(paths.OPERATORS);
    const fromFile = file.data && Array.isArray(file.data.operators)
        ? file.data.operators.map((n) => channels.normalize(n)).filter((n) => paths.isValidLogin(n))
        : [];
    const fromEnv = (process.env.WEBUI_OPERATORS || '').split(/[,\s]+/).map((n) => channels.normalize(n)).filter((n) => paths.isValidLogin(n));
    const fromLegacy = (config.allowedUsers || []).map((n) => channels.normalize(n)).filter((n) => paths.isValidLogin(n));

    return {
        operators: loadOperators(config.allowedUsers),
        fromFile,
        // 環境変数と旧形式の webui.json は画面からは変更できない
        fromEnv,
        fromLegacy,
        path: configStore.relativePath(paths.OPERATORS)
    };
}

module.exports = { createApiRouter };
