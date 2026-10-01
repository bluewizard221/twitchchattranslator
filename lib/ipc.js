'use strict';

const crypto = require('crypto');

/**
 * 管理プロセスと子プロセス（管理画面など）の間の要求・応答。
 * Node の IPC チャネル（process.send / 'message'）の上で、id で要求と応答を対応付ける。
 *
 *   要求: { type: 'request', id, action, payload }
 *   応答: { type: 'response', id, ok, result?, error? }
 */

/**
 * 子プロセス側: 管理プロセスに要求を送り、応答を待つ。
 * @param {object} channel process（IPC 付きで起動された子プロセス）
 */
function createClient(channel, options) {
    const timeoutMs = (options && options.timeoutMs) || 15000;
    const pending = new Map();

    channel.on('message', (msg) => {
        if (!msg || msg.type !== 'response' || !pending.has(msg.id)) { return; }

        const entry = pending.get(msg.id);

        pending.delete(msg.id);
        clearTimeout(entry.timer);

        if (msg.ok) {
            entry.resolve(msg.result);
        } else {
            entry.reject(new Error(msg.error || '管理プロセスでエラーが発生しました。'));
        }
    });

    function request(action, payload) {
        if (typeof channel.send !== 'function' || channel.connected === false) {
            return Promise.reject(new Error('管理プロセスに接続されていません（manager.js の外で起動しています）。'));
        }

        const id = crypto.randomBytes(8).toString('hex');

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error('管理プロセスからの応答がありません: ' + action));
            }, timeoutMs);

            // unref しない: 応答を待っている間にプロセスが終わらないようにする（待つのは最長 timeoutMs）
            pending.set(id, { resolve, reject, timer });
            channel.send({ type: 'request', id, action, payload });
        });
    }

    return { request, available: () => typeof channel.send === 'function' && channel.connected !== false };
}

/**
 * 管理プロセス側: 子プロセスからの要求を処理して応答を返す。
 * @param {Object<string, function(payload): Promise<*>>} handlers action ごとの処理
 * @param {function(name, msg)} send 子プロセスへの送信
 */
function createServer(handlers, send) {
    return async function onMessage(name, msg) {
        if (!msg || msg.type !== 'request' || typeof msg.id !== 'string') { return; }

        const handler = Object.prototype.hasOwnProperty.call(handlers, msg.action) ? handlers[msg.action] : null;

        if (!handler) {
            send(name, { type: 'response', id: msg.id, ok: false, error: '不明な操作です: ' + msg.action });
            return;
        }

        try {
            const result = await handler(msg.payload || {}, name);

            send(name, { type: 'response', id: msg.id, ok: true, result });
        } catch (err) {
            send(name, { type: 'response', id: msg.id, ok: false, error: err.message });
        }
    };
}

module.exports = { createClient, createServer };
