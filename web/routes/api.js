'use strict';

const express = require('express');
const paths = require('../../lib/paths');
const configStore = require('../lib/configStore');
const configSchema = require('../lib/configSchema');
const lists = require('../../lib/lists');
const emotes = require('../../lib/emotes');
const googleKey = require('../lib/googleKey');
const bot = require('../lib/bot');
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

        const channel = String(body.channel || values.twitchChannel || '').trim();
        const userId = String(body.userId || values.twitchBroadcasterId || '').trim();
        const mode = body.mode === 'replace' ? 'replace' : 'merge';
        const save = body.save !== false;

        if (!channel) {
            return res.status(400).json({ error: '対象チャンネル名が設定されていません。先に「基本設定」で設定してください。' });
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
            botUserName: values.twitchUserName || null,
            missingRequired: missing,
            lists: listSummary,
            bot: bot.status(values.pidFile),
            googleKey: googleKey.status(values.googleKeyFile),
            config: configStore.localMeta(),
            oauth: oauthValues(req)
        });
    });

    return router;
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
