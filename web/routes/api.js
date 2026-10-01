'use strict';

const express = require('express');
const paths = require('../../lib/paths');
const configStore = require('../lib/configStore');
const configSchema = require('../lib/configSchema');
const lists = require('../../lib/lists');
const emotes = require('../../lib/emotes');
const googleKey = require('../lib/googleKey');
const bot = require('../lib/bot');
const logs = require('../lib/logs');
const { readJson, writeJsonAtomic } = require('../../lib/fileStore');
const { requireCsrf } = require('../middleware/auth');

function createApiRouter(config, logger) {
    const router = express.Router();

    router.use(requireCsrf);

    // ------------------------------------------------------------------
    // セッション情報
    // ------------------------------------------------------------------
    router.get('/session', (req, res) => {
        res.json({
            user: req.session.user,
            csrfToken: req.session.csrfToken,
            allowedUsers: config.allowedUsers
        });
    });

    // ------------------------------------------------------------------
    // 設定ファイル（config/local.json）
    // ------------------------------------------------------------------
    router.get('/config', (req, res) => {
        const snapshot = configStore.snapshot();

        res.json({
            fields: configSchema.publicFields(),
            groups: configSchema.GROUPS,
            values: snapshot.values,
            layers: snapshot.layers,
            meta: configStore.localMeta(),
            oauth: oauthValues(req)
        });
    });

    router.put('/config', (req, res) => {
        // 対象チャンネルはログイン中のアカウントのものしか設定させない（他人のチャンネルへの投稿を防ぐ）
        const lockErrors = loginLockedErrors(req.body && req.body.values, req.session.user);

        if (lockErrors) {
            logger.warn('ログイン中のアカウント以外のチャンネル設定を拒否しました [' + req.session.user.login + '] 項目: ' +
                Object.keys(lockErrors).join(', '));
            return res.status(400).json({ error: '入力内容を確認してください。', fieldErrors: lockErrors });
        }

        const result = configStore.saveLocal(req.body && req.body.values);

        if (!result.ok) {
            return res.status(400).json({ error: '入力内容を確認してください。', fieldErrors: result.errors });
        }

        logger.info('設定を更新しました [' + req.session.user.login + '] 項目: ' + (result.saved.join(', ') || 'なし'));

        const snapshot = configStore.snapshot();

        res.json({
            ok: true,
            saved: result.saved,
            missingRequired: result.missingRequired,
            values: snapshot.values,
            layers: snapshot.layers,
            meta: configStore.localMeta()
        });
    });

    // ------------------------------------------------------------------
    // 各種リスト（翻訳しないユーザー / 文字列 / エモート）
    // ------------------------------------------------------------------
    router.get('/lists', (req, res) => {
        const result = {};

        for (const def of lists.describeAll()) {
            const data = lists.read(def.id);

            result[def.id] = {
                label: def.label,
                help: def.help,
                placeholder: def.placeholder,
                path: configStore.relativePath(def.path),
                items: data.items,
                error: data.error,
                updatedAt: data.updatedAt
            };
        }

        res.json(result);
    });

    router.put('/lists/:id', (req, res) => {
        const id = req.params.id;

        if (!lists.getList(id)) {
            return res.status(404).json({ error: '不明なリストです。' });
        }

        const result = lists.write(id, req.body && req.body.items);

        if (!result.ok) {
            return res.status(400).json({ error: '入力内容を確認してください。', errors: result.errors });
        }

        logger.info('リストを更新しました [' + req.session.user.login + '] ' + id + ': ' + result.items.length + ' 件');

        res.json({
            ok: true,
            items: result.items,
            removedDuplicates: result.removedDuplicates,
            updatedAt: lists.read(id).updatedAt
        });
    });

    // ------------------------------------------------------------------
    // emoticons.json の自動更新（BTTV / FFZ）
    // ------------------------------------------------------------------
    router.post('/emotes/refresh', async (req, res) => {
        const body = req.body || {};
        const values = configStore.usableValues();

        // 対象は設定済みのチャンネルのみ（リクエストでチャンネルを指定させない）
        const channel = String(values.twitchChannel || '').trim();
        const userId = String(values.twitchBroadcasterId || '').trim();
        const mode = body.mode === 'replace' ? 'replace' : 'merge';
        const save = body.save !== false;

        if (!channel) {
            return res.status(400).json({ error: '対象チャンネル名が設定されていません。先に「基本設定」で設定してください。' });
        }

        if (!matchesLogin(values, req.session.user)) {
            return res.status(409).json({
                error: '対象チャンネル（' + channel + '）がログイン中のアカウント（' + req.session.user.login +
                    '）と異なるため、エモートを取得できません。「基本設定」でログイン中のアカウントを対象にしてください。'
            });
        }

        let fetched;

        try {
            fetched = await emotes.fetchEmoteNames({ twitchChannel: channel, twitchUserId: userId });
        } catch (err) {
            logger.error('エモート取得に失敗しました: ' + err.message);
            return res.status(502).json({ error: 'エモートの取得に失敗しました: ' + err.message });
        }

        // 全滅した場合に空の一覧で上書きしてしまわないようにする
        if (fetched.sources.every((source) => !source.ok)) {
            return res.status(502).json({
                error: 'どの取得元からもエモートを取得できませんでした。emoticons.json は変更していません。',
                errors: fetched.warnings
            });
        }

        const current = lists.read('emoticons');
        const before = current.items;
        const merged = mode === 'merge'
            ? Array.from(new Set(before.concat(fetched.names)))
            : fetched.names;

        const response = {
            ok: true,
            mode: mode,
            saved: false,
            channel: channel,
            userId: userId || null,
            sources: fetched.sources,
            warnings: fetched.warnings.slice(),
            before: before.length,
            after: merged.length,
            added: merged.filter((name) => before.indexOf(name) === -1).length,
            removed: before.filter((name) => merged.indexOf(name) === -1).length,
            items: merged
        };

        if (!save) {
            return res.json(response);
        }

        const written = lists.write('emoticons', merged);

        if (!written.ok) {
            return res.status(400).json({ error: '取得したエモートを保存できませんでした。', errors: written.errors });
        }

        response.saved = true;
        response.items = written.items;
        response.after = written.items.length;

        // CLI（NODE_ENV=jsonupdate ./emotelistupdate.js）でも同じ値を使えるようにしておく
        const synced = syncJsonUpdateConfig(channel, userId, logger);

        if (synced) { response.warnings.push(synced); }

        logger.info('エモート一覧を更新しました [' + req.session.user.login + '] ' +
            before.length + ' 件 → ' + written.items.length + ' 件（' + mode + '）');

        res.json(response);
    });

    // ------------------------------------------------------------------
    // Google Cloud サービスアカウントキー
    // ------------------------------------------------------------------
    router.get('/google-key', (req, res) => {
        const values = configStore.usableValues();

        res.json({
            status: googleKey.status(values.googleKeyFile),
            projectId: values.googleProjectId || null,
            defaultPath: configStore.relativePath(paths.DEFAULT_GOOGLE_KEY),
            maxBytes: googleKey.MAX_KEY_BYTES
        });
    });

    router.post('/google-key', (req, res) => {
        const body = req.body || {};
        const result = googleKey.save(body.content, body.fileName);

        if (!result.ok) {
            return res.status(400).json({ error: result.error, warnings: result.warnings });
        }

        const applied = [];
        const patch = { googleKeyFile: result.path };

        // プロジェクト ID はキーファイルから自動で埋める
        if (body.applyProjectId !== false) {
            patch.googleProjectId = result.projectId;
        }

        const saved = configStore.saveLocal(patch);

        if (!saved.ok) {
            return res.status(500).json({
                error: 'キーは保存しましたが、設定への反映に失敗しました。',
                fieldErrors: saved.errors,
                path: result.path
            });
        }

        applied.push(...saved.saved);

        logger.info('Google Cloud キーを更新しました [' + req.session.user.login + '] ' + result.path +
            ' (project: ' + result.projectId + ')');

        res.json({
            ok: true,
            path: result.path,
            projectId: result.projectId,
            clientEmail: result.clientEmail,
            applied: applied,
            warnings: result.warnings,
            status: googleKey.status(result.path)
        });
    });

    // ------------------------------------------------------------------
    // bot プロセスの状態と再読み込み
    // ------------------------------------------------------------------
    router.get('/bot/status', (req, res) => {
        const values = configStore.usableValues();

        res.json(bot.status(values.pidFile));
    });

    router.post('/bot/reload', (req, res) => {
        const values = configStore.usableValues();
        const result = bot.reload(values.pidFile);

        if (!result.ok) {
            return res.status(409).json({ error: result.error });
        }

        logger.info('bot に SIGHUP を送信しました [' + req.session.user.login + '] pid: ' + result.pid);

        res.json({ ok: true, message: result.message, pid: result.pid });
    });

    // ------------------------------------------------------------------
    // ダッシュボード用のまとめ
    // ------------------------------------------------------------------
    router.get('/overview', (req, res) => {
        const effective = configStore.loadEffective();
        const missing = configStore.incompleteRequired(effective.values, effective.sources);
        // 表示にはテンプレートの説明文を混ぜない
        const values = configStore.usableValues();

        const listSummary = lists.describeAll().map((def) => {
            const data = lists.read(def.id);

            return { id: def.id, label: def.label, count: data.items.length, error: data.error, updatedAt: data.updatedAt };
        });

        res.json({
            channel: values.twitchChannel || null,
            broadcasterId: values.twitchBroadcasterId || null,
            // config/default.json を直接書き換えた場合などに、ログイン中のアカウントと食い違うことがある
            channelMatchesLogin: matchesLogin(values, req.session.user),
            loginChannel: req.session.user.login,
            // bot と同じ既定値（twitchchattranslator.js の streamStatusPollSeconds || 60）
            streamStatusPollSeconds: Number(values.streamStatusPollSeconds) || 60,
            botUserName: values.twitchUserName || null,
            missingRequired: missing,
            lists: listSummary,
            bot: bot.status(values.pidFile),
            googleKey: googleKey.status(values.googleKeyFile),
            config: configStore.localMeta(),
            oauth: oauthValues(req)
        });
    });

    // ------------------------------------------------------------------
    // ログの閲覧（読み取りのみ。LOGS に登録したファイルだけ）
    // ------------------------------------------------------------------
    router.get('/logs', (req, res) => {
        res.json({ logs: logs.describeAll(), defaultLines: logs.DEFAULT_LINES, maxLines: logs.MAX_LINES });
    });

    router.get('/logs/:id', (req, res) => {
        const result = logs.tail(req.params.id, { lines: req.query.lines, level: req.query.level });

        if (!result) {
            return res.status(404).json({ error: '不明なログです。' });
        }

        res.json(result);
    });

    return router;
}

/**
 * ログイン中のアカウントに固定する項目（configSchema の oauth 指定がある項目）の検査。
 * 空欄（local.json の値を取り消す）は許可し、ログイン中のアカウントと異なる値だけを拒否する。
 * @returns {object|null} 項目ごとのエラー。問題がなければ null
 */
function loginLockedErrors(values, user) {
    if (!values || typeof values !== 'object' || !user) { return null; }

    const errors = {};

    for (const field of configSchema.FIELDS) {
        if (!field.oauth || !Object.prototype.hasOwnProperty.call(values, field.key)) { continue; }

        const raw = values[field.key];
        const value = raw === null || raw === undefined ? '' : String(raw).trim();

        if (value === '') { continue; }

        const expected = field.oauth === 'login' ? String(user.login) : String(user.id);
        const same = field.oauth === 'login' ? value.toLowerCase() === expected.toLowerCase() : value === expected;

        if (!same) {
            errors[field.key] = field.label + 'は、ログイン中のアカウント（' + user.login + '）のものしか設定できません。' +
                '「ログイン情報から」で入力してください。';
        }
    }

    return Object.keys(errors).length > 0 ? errors : null;
}

/** 設定済みのチャンネル（と配信者 ID）がログイン中のアカウントと一致するか。未設定の項目は比較しない */
function matchesLogin(values, user) {
    if (!user) { return false; }

    const channel = String(values.twitchChannel || '').trim();
    const broadcasterId = String(values.twitchBroadcasterId || '').trim();

    if (channel && channel.toLowerCase() !== String(user.login).toLowerCase()) { return false; }
    if (broadcasterId && broadcasterId !== String(user.id)) { return false; }

    return true;
}

/** ログイン中の Twitch アカウントから流用できる値 */
function oauthValues(req) {
    const user = req.session.user;

    if (!user) { return null; }

    return {
        twitchChannel: user.login,
        twitchBroadcasterId: user.id,
        displayName: user.displayName
    };
}

/**
 * emotelistupdate.js が使う config/jsonupdate.json を同じ値に揃える。
 * 失敗しても本体の処理は続行し、警告文だけを返す。
 */
function syncJsonUpdateConfig(channel, userId, logger) {
    try {
        const current = readJson(paths.JSONUPDATE_CONFIG);
        const root = current.data && typeof current.data === 'object' && !Array.isArray(current.data) ? current.data : {};
        const section = root.config && typeof root.config === 'object' ? root.config : {};

        section.twitchChannel = channel;

        if (userId) { section.twitchUserId = userId; }

        writeJsonAtomic(paths.JSONUPDATE_CONFIG, Object.assign({}, root, { config: section }), { mode: 0o644 });

        return null;
    } catch (err) {
        logger.warn('config/jsonupdate.json の同期に失敗しました: ' + err.message);

        return 'config/jsonupdate.json の同期に失敗しました: ' + err.message;
    }
}

module.exports = { createApiRouter };
