'use strict';

const crypto = require('crypto');

/**
 * EventSub（Webhook）の受信口（仕様書 7.2 節）。
 * 公開の受信口で、ログインはない。守りは署名の検証だけなので、検証に通らないものは一切処理しない。
 *
 * - 署名: HMAC-SHA256(secret, message_id + timestamp + 生の本文) を Twitch-Eventsub-Message-Signature と比べる
 * - 登録確認（webhook_callback_verification）: 200 と challenge の値そのもの（text/plain）を返す
 * - 通知（notification）: メッセージ ID で重複を除き、10 分より古いものは捨てる。どちらも 2xx を返す（再送させない）
 * - 取り消し（revocation）: 記録して呼び出し側に知らせる
 */

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_AGE_MS = 10 * 60 * 1000;

const H = {
    id: 'twitch-eventsub-message-id',
    timestamp: 'twitch-eventsub-message-timestamp',
    signature: 'twitch-eventsub-message-signature',
    type: 'twitch-eventsub-message-type'
};

function sign(secret, messageId, timestamp, rawBody) {
    return 'sha256=' + crypto.createHmac('sha256', secret)
        .update(messageId + timestamp)
        .update(rawBody)
        .digest('hex');
}

function verifySignature(secret, headers, rawBody) {
    const messageId = headers[H.id];
    const timestamp = headers[H.timestamp];
    const signature = headers[H.signature];

    if (!secret || !messageId || !timestamp || typeof signature !== 'string') { return false; }

    const expected = Buffer.from(sign(secret, messageId, timestamp, rawBody), 'utf8');
    const given = Buffer.from(signature, 'utf8');

    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** 受け取ったメッセージ ID を一定時間覚えておく（重複の除去） */
class RecentIds {
    constructor(ttlMs, maxSize, now) {
        this.ttlMs = ttlMs;
        this.maxSize = maxSize;
        this.now = now;
        this.ids = new Map();
    }

    seen(id) {
        const current = this.now();

        for (const [key, expires] of this.ids) {
            if (expires > current) { break; }
            this.ids.delete(key);
        }

        if (this.ids.has(id)) { return true; }

        if (this.ids.size >= this.maxSize) {
            this.ids.delete(this.ids.keys().next().value);
        }

        this.ids.set(id, current + this.ttlMs);
        return false;
    }
}

/**
 * Node の http サーバーに渡すハンドラーを作る。
 * @param {object} options
 * @param {string} options.secret                 署名用シークレット（10〜100 文字）
 * @param {function(type, event, subscription)} options.onNotification
 * @param {function(subscription)} [options.onRevocation]
 * @param {object} [options.logger]
 * @param {string} [options.path='/eventsub/callback']
 */
function createHandler(options) {
    const opts = Object.assign({ path: '/eventsub/callback', now: Date.now }, options);
    const logger = opts.logger || console;
    const recent = new RecentIds(MAX_AGE_MS, 10000, opts.now);

    if (typeof opts.secret !== 'string' || opts.secret.length < 10 || opts.secret.length > 100) {
        throw new Error('EventSub の署名用シークレットは 10〜100 文字にしてください。');
    }

    function reply(res, status, body, type) {
        const text = body || '';

        res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
    }

    return function handle(req, res) {
        const url = (req.url || '').split('?')[0];

        if (req.method !== 'POST' || url !== opts.path) {
            return reply(res, 404, 'not found');
        }

        const chunks = [];
        let size = 0;
        let aborted = false;

        req.on('data', (chunk) => {
            size += chunk.length;

            if (size > MAX_BODY_BYTES) {
                aborted = true;
                reply(res, 413, 'payload too large');
                req.destroy();
                return;
            }

            chunks.push(chunk);
        });

        req.on('end', () => {
            if (aborted) { return; }

            const raw = Buffer.concat(chunks);

            if (!verifySignature(opts.secret, req.headers, raw)) {
                logger.warn('EventSub: 署名を検証できないリクエストを拒否しました');
                return reply(res, 403, 'invalid signature');
            }

            let body;

            try {
                body = JSON.parse(raw.toString('utf8'));
            } catch (err) {
                return reply(res, 400, 'invalid json');
            }

            const messageType = req.headers[H.type];
            const subscription = body && body.subscription ? body.subscription : {};

            if (messageType === 'webhook_callback_verification') {
                logger.info('EventSub: 購読の登録確認に応答しました ' + subscription.type + ' (' + subscription.id + ')');
                return reply(res, 200, String(body.challenge || ''));
            }

            if (messageType === 'revocation') {
                logger.warn('EventSub: 購読が取り消されました ' + subscription.type + ' (' + subscription.id + ') 理由: ' + subscription.status);
                reply(res, 204);
                if (opts.onRevocation) { opts.onRevocation(subscription); }
                return;
            }

            if (messageType !== 'notification') {
                return reply(res, 204);
            }

            const timestamp = Date.parse(req.headers[H.timestamp]);

            if (!Number.isFinite(timestamp) || opts.now() - timestamp > MAX_AGE_MS) {
                logger.warn('EventSub: 古い通知を破棄しました ' + req.headers[H.id]);
                return reply(res, 204);
            }

            if (recent.seen(req.headers[H.id])) {
                return reply(res, 204);
            }

            reply(res, 204);

            try {
                opts.onNotification(subscription.type, body.event || {}, subscription);
            } catch (err) {
                logger.error('EventSub: 通知の処理に失敗しました ' + subscription.type + ': ' + err.message);
            }
        });
    };
}

module.exports = { createHandler, verifySignature, sign, HEADERS: H, MAX_AGE_MS };
