'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('../../lib/paths');
const channels = require('../../lib/channels');
const audit = require('../../lib/audit');
const botConnection = require('./botConnection');

/**
 * チャンネルの登録と削除（運営者の操作。仕様書 6・11 節）。
 */

async function notifyManager(manager, action, payload, logger) {
    try {
        return { ok: true, result: await manager.request(action, payload || {}) };
    } catch (err) {
        if (logger) { logger.warn('管理プロセスへの依頼に失敗しました（' + action + '）: ' + err.message); }
        return { ok: false, error: err.message };
    }
}

async function register(login, actor, deps) {
    const created = channels.create(login, { createdBy: actor });

    if (!created.ok) { return created; }

    audit.append({ actor, action: 'channel.register', channel: created.channel.login });

    const notified = await notifyManager(deps.manager, 'channels.changed', {}, deps.logger);

    return { ok: true, channel: created.channel, warnings: notified.ok ? [] : ['管理プロセスに反映できませんでした: ' + notified.error] };
}

/**
 * チャンネルの削除（D11: 即削除。特にトークンと Google Cloud の認証情報は必ず消す）。
 *   1. bot を止める
 *   2. EventSub の購読を削除する（止めたチャンネルを除いて突き合わせる）
 *   3. bot のトークンを Twitch 側で無効化する
 *   4. ファイルを削除する（GCP のキー・トークン・設定・リスト・ログ・使用量）
 *   5. その配信者のセッションを無効にする
 *   6. 操作の記録を残す
 * 管理プロセスに接続できない段階は失敗として記録し、3〜6 は必ず行う。
 *
 * @param {object} deps { manager, revokeToken(token) => Promise<boolean>, sessionStore, logger }
 */
async function remove(login, actor, deps) {
    const name = channels.normalize(login);

    if (!channels.exists(name)) {
        return { ok: false, error: '登録されていないチャンネルです: ' + name };
    }

    const steps = [];
    const step = (id, ok, detail) => steps.push({ step: id, ok, detail: detail || null });

    const stopped = await notifyManager(deps.manager, 'channel.stop', { login: name }, deps.logger);

    step('stop', stopped.ok, stopped.error);

    const synced = await notifyManager(deps.manager, 'eventsub.sync', {}, deps.logger);
    const syncErrors = synced.ok && synced.result && Array.isArray(synced.result.errors) ? synced.result.errors : [];

    step('subscriptions', synced.ok && syncErrors.length === 0, synced.ok ? (syncErrors.join(' / ') || null) : synced.error);

    const tokens = botConnection.readTokens(name);

    if (tokens) {
        const results = await Promise.all([tokens.accessToken, tokens.refreshToken].filter(Boolean).map((t) => deps.revokeToken(t)));

        step('revoke', results.every(Boolean), results.every(Boolean) ? null : '一部のトークンを無効化できませんでした（すでに無効の可能性があります）');
    } else {
        step('revoke', true, 'bot アカウントは接続されていませんでした');
    }

    channels.removeFiles(name);

    try {
        fs.unlinkSync(path.join(paths.USAGE_DIR, name + '.json'));
    } catch (err) {
        // 使用量の記録が無ければ何もしない
    }

    step('files', !fs.existsSync(paths.channel(name).root));

    const sessions = deps.sessionStore ? deps.sessionStore.destroyByLogin(name) : 0;

    step('sessions', true, sessions + ' 件のセッションを無効にしました');

    // 突き合わせから外れたので、管理プロセスの登録からも外す
    await notifyManager(deps.manager, 'channels.changed', {}, deps.logger);

    audit.append({
        actor,
        action: 'channel.delete',
        channel: name,
        detail: { steps: steps.map((s) => s.step + ':' + (s.ok ? 'ok' : 'failed')) }
    });
    step('audit', true);

    return {
        ok: true,
        steps,
        notices: [
            'Google Cloud のキーのファイルは削除しましたが、GCP 側ではキーが有効なままです。配信者に GCP のコンソールでキーを削除するよう伝えてください。',
            '配信者と bot アカウントは、Twitch の「設定 → 接続」からこのアプリへの許可を外せます。'
        ]
    };
}

module.exports = { register, remove, notifyManager };
