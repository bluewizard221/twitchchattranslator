'use strict';

/**
 * チャンネルごとに必要な EventSub の購読と、実際の購読との突き合わせ（仕様書 7.2 節）。
 * 突き合わせの対象は、自分の受信口（callback）宛ての購読だけ。ほかの用途の購読には触れない。
 */

/** 1 チャンネル分の必要な購読 */
function desiredFor(channel) {
    const broadcaster = String(channel.broadcasterId);
    const bot = String(channel.botUserId);

    return [
        { type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: broadcaster, user_id: bot } },
        { type: 'channel.chat.message_delete', version: '1', condition: { broadcaster_user_id: broadcaster, user_id: bot } },
        { type: 'channel.chat.clear_user_messages', version: '1', condition: { broadcaster_user_id: broadcaster, user_id: bot } },
        { type: 'stream.online', version: '1', condition: { broadcaster_user_id: broadcaster } },
        { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: broadcaster } }
    ];
}

/** 種類・版・条件が同じなら同じ購読とみなすためのキー */
function keyOf(sub) {
    const condition = sub.condition || {};
    const parts = Object.keys(condition).sort().map((k) => k + '=' + condition[k]);

    return sub.type + '@' + sub.version + '?' + parts.join('&');
}

// 作り直しが必要な状態（有効でない購読は消して作り直す）
const ACTIVE = new Set(['enabled', 'webhook_callback_verification_pending']);

/**
 * 突き合わせの計画を立てる。
 * @param {object[]} desired 必要な購読
 * @param {object[]} existing Twitch 上の購読（listSubscriptions の結果）
 * @param {string} callback 自分の受信口の URL
 * @returns {{ create: object[], remove: object[], keep: object[] }}
 */
function plan(desired, existing, callback) {
    const ours = existing.filter((sub) => sub.transport && sub.transport.method === 'webhook' && sub.transport.callback === callback);
    const wanted = new Map(desired.map((sub) => [keyOf(sub), sub]));
    const keep = [];
    const remove = [];
    const have = new Set();

    for (const sub of ours) {
        const key = keyOf(sub);

        if (wanted.has(key) && ACTIVE.has(sub.status) && !have.has(key)) {
            keep.push(sub);
            have.add(key);
        } else {
            remove.push(sub);
        }
    }

    const create = desired.filter((sub) => !have.has(keyOf(sub)));

    return { create, remove, keep };
}

/**
 * 計画を実行する。
 * @param {object} api lib/twitchApi.js
 * @param {object[]} desired
 * @param {{ callback: string, secret: string, logger?: object }} options
 */
async function reconcile(api, desired, options) {
    const logger = options.logger || console;
    const existing = await api.listSubscriptions();
    const steps = plan(desired, existing, options.callback);
    const errors = [];

    for (const sub of steps.remove) {
        try {
            await api.deleteSubscription(sub.id);
        } catch (err) {
            errors.push('削除 ' + sub.type + ': ' + err.message);
        }
    }

    for (const sub of steps.create) {
        try {
            await api.createSubscription(sub.type, sub.version, sub.condition, options.callback, options.secret);
        } catch (err) {
            errors.push('作成 ' + sub.type + ' ' + JSON.stringify(sub.condition) + ': ' + err.message +
                (err.body && err.body.message ? '（' + err.body.message + '）' : ''));
        }
    }

    logger.info('EventSub の購読を突き合わせました: 維持 ' + steps.keep.length + ' / 作成 ' + steps.create.length +
        ' / 削除 ' + steps.remove.length + (errors.length ? ' / 失敗 ' + errors.length : ''));

    for (const error of errors) { logger.error('EventSub: ' + error); }

    return { kept: steps.keep.length, created: steps.create.length, removed: steps.remove.length, errors };
}

module.exports = { desiredFor, keyOf, plan, reconcile };
