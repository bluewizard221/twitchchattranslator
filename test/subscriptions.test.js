'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { desiredFor, plan, reconcile, keyOf } = require('../lib/subscriptions');

const CB = 'https://translate.example/eventsub/callback';
const sub = (id, type, condition, extra) => Object.assign({
    id, type, version: '1', condition, status: 'enabled', transport: { method: 'webhook', callback: CB }
}, extra || {});

test('1 チャンネル分の購読は 5 種類で、チャット系は bot の ID を条件に含む', () => {
    const desired = desiredFor({ broadcasterId: 100, botUserId: 200 });

    assert.deepStrictEqual(desired.map((d) => d.type), [
        'channel.chat.message', 'channel.chat.message_delete', 'channel.chat.clear_user_messages', 'stream.online', 'stream.offline'
    ]);
    assert.deepStrictEqual(desired[0].condition, { broadcaster_user_id: '100', user_id: '200' });
    assert.deepStrictEqual(desired[3].condition, { broadcaster_user_id: '100' });
});

test('計画: あるものは維持、無いものは作成、不要・無効・重複は削除。ほかの受信口宛てには触れない', () => {
    const desired = desiredFor({ broadcasterId: '100', botUserId: '200' });
    const existing = [
        sub('keep', 'stream.online', { broadcaster_user_id: '100' }),
        sub('dup', 'stream.online', { broadcaster_user_id: '100' }),
        sub('failed', 'stream.offline', { broadcaster_user_id: '100' }, { status: 'authorization_revoked' }),
        sub('gone', 'stream.online', { broadcaster_user_id: '999' }),
        sub('other', 'stream.online', { broadcaster_user_id: '999' }, { transport: { method: 'webhook', callback: 'https://elsewhere/cb' } })
    ];
    const p = plan(desired, existing, CB);

    assert.deepStrictEqual(p.keep.map((s) => s.id), ['keep']);
    assert.deepStrictEqual(p.remove.map((s) => s.id).sort(), ['dup', 'failed', 'gone']);
    assert.strictEqual(p.create.length, 4);
    assert.ok(p.create.some((c) => c.type === 'stream.offline'), '無効になったものは作り直す');
    assert.strictEqual(keyOf(desired[0]), keyOf({ type: 'channel.chat.message', version: '1', condition: { user_id: '200', broadcaster_user_id: '100' } }), '条件の順番に依存しない');
});

test('実行: 削除してから作成し、失敗は記録して続ける', async () => {
    const calls = [];
    const api = {
        listSubscriptions: async () => [sub('gone', 'stream.online', { broadcaster_user_id: '999' })],
        deleteSubscription: async (id) => calls.push('delete ' + id),
        createSubscription: async (type, version, condition, callback, secret) => {
            calls.push('create ' + type);
            assert.strictEqual(callback, CB);
            assert.strictEqual(secret, 'shh-secret-123');
            if (type === 'channel.chat.message') {
                const err = new Error('403');
                err.body = { message: 'missing channel:bot' };
                throw err;
            }
        }
    };
    const result = await reconcile(api, desiredFor({ broadcasterId: '1', botUserId: '2' }), { callback: CB, secret: 'shh-secret-123', logger: { info() {}, error() {} } });

    assert.strictEqual(calls[0], 'delete gone');
    assert.strictEqual(calls.filter((c) => c.startsWith('create')).length, 5);
    assert.strictEqual(result.created, 5);
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes('missing channel:bot'));
});
