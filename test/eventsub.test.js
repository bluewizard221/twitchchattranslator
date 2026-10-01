'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createHandler, sign } = require('../lib/eventsub');

const SECRET = 'test-secret-1234567890';
const quiet = { info() {}, warn() {}, error() {} };

async function withServer(options, fn) {
    const handler = createHandler(Object.assign({ secret: SECRET, logger: quiet, onNotification() {} }, options));
    const server = http.createServer(handler);

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        return await fn('http://127.0.0.1:' + server.address().port);
    } finally {
        server.close();
    }
}

function post(base, body, headers, opts) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const id = (opts && opts.id) || 'msg-' + Math.random();
    const ts = (opts && opts.timestamp) || new Date().toISOString();
    const h = Object.assign({
        'Content-Type': 'application/json',
        'Twitch-Eventsub-Message-Id': id,
        'Twitch-Eventsub-Message-Timestamp': ts,
        'Twitch-Eventsub-Message-Signature': sign((opts && opts.secret) || SECRET, id, ts, raw),
        'Twitch-Eventsub-Message-Type': 'notification'
    }, headers || {});

    return fetch(base + ((opts && opts.path) || '/eventsub/callback'), { method: 'POST', headers: h, body: raw })
        .then(async (res) => ({ status: res.status, text: await res.text(), length: res.headers.get('content-length'), type: res.headers.get('content-type') }));
}

const notification = (type, event) => ({ subscription: { id: 's1', type, version: '1', status: 'enabled' }, event });

test('正しい署名の通知は処理し、204 を返す', async () => {
    const got = [];

    await withServer({ onNotification: (type, event) => got.push([type, event.message_id]) }, async (base) => {
        const res = await post(base, notification('channel.chat.message', { message_id: 'x1' }));

        assert.strictEqual(res.status, 204);
    });
    assert.deepStrictEqual(got, [['channel.chat.message', 'x1']]);
});

test('署名が違う・欠けている・別のシークレットのものは 403 で、処理しない', async () => {
    const got = [];

    await withServer({ onNotification: () => got.push(1) }, async (base) => {
        assert.strictEqual((await post(base, notification('a', {}), {}, { secret: 'another-secret-xyz' })).status, 403);
        assert.strictEqual((await post(base, notification('a', {}), { 'Twitch-Eventsub-Message-Signature': 'sha256=00' })).status, 403);
        assert.strictEqual((await post(base, notification('a', {}), { 'Twitch-Eventsub-Message-Signature': '' })).status, 403);
    });
    assert.strictEqual(got.length, 0);
});

test('本文を 1 文字でも書き換えると 403', async () => {
    await withServer({}, async (base) => {
        const raw = JSON.stringify(notification('a', { x: 1 }));
        const id = 'm';
        const ts = new Date().toISOString();
        const res = await fetch(base + '/eventsub/callback', {
            method: 'POST',
            headers: {
                'Twitch-Eventsub-Message-Id': id, 'Twitch-Eventsub-Message-Timestamp': ts,
                'Twitch-Eventsub-Message-Signature': sign(SECRET, id, ts, raw), 'Twitch-Eventsub-Message-Type': 'notification'
            },
            body: raw.replace('"x":1', '"x":2')
        });

        assert.strictEqual(res.status, 403);
    });
});

test('登録確認には 200 と challenge の値そのもの（text/plain、正しい長さ）を返す', async () => {
    await withServer({}, async (base) => {
        const res = await post(base, { challenge: 'pogchamp-kappa-360noscope', subscription: { id: 's', type: 't' } },
            { 'Twitch-Eventsub-Message-Type': 'webhook_callback_verification' });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.text, 'pogchamp-kappa-360noscope');
        assert.strictEqual(res.length, String('pogchamp-kappa-360noscope'.length));
        assert.ok(res.type.startsWith('text/plain'));
    });
});

test('同じメッセージ ID の再送は 1 回だけ処理する', async () => {
    const got = [];

    await withServer({ onNotification: (type) => got.push(type) }, async (base) => {
        const body = notification('stream.online', {});

        assert.strictEqual((await post(base, body, {}, { id: 'dup' })).status, 204);
        assert.strictEqual((await post(base, body, {}, { id: 'dup' })).status, 204);
    });
    assert.strictEqual(got.length, 1);
});

test('10 分より古い通知は 2xx を返して捨てる（再送させない）', async () => {
    const got = [];

    await withServer({ onNotification: () => got.push(1) }, async (base) => {
        const old = new Date(Date.now() - 11 * 60e3).toISOString();

        assert.strictEqual((await post(base, notification('a', {}), {}, { timestamp: old })).status, 204);
    });
    assert.strictEqual(got.length, 0);
});

test('購読の取り消しは呼び出し側に知らせる', async () => {
    const revoked = [];

    await withServer({ onRevocation: (sub) => revoked.push(sub.status) }, async (base) => {
        const res = await post(base, { subscription: { id: 's', type: 'channel.chat.message', status: 'authorization_revoked' } },
            { 'Twitch-Eventsub-Message-Type': 'revocation' });

        assert.strictEqual(res.status, 204);
    });
    assert.deepStrictEqual(revoked, ['authorization_revoked']);
});

test('別のパス・POST 以外は 404、大きすぎる本文は 413', async () => {
    await withServer({}, async (base) => {
        assert.strictEqual((await post(base, notification('a', {}), {}, { path: '/other' })).status, 404);
        assert.strictEqual((await fetch(base + '/eventsub/callback')).status, 404);
        assert.strictEqual((await post(base, 'x'.repeat(1024 * 1024 + 10))).status, 413);
    });
});

test('シークレットが短すぎる・長すぎると作れない', () => {
    assert.throws(() => createHandler({ secret: 'short', onNotification() {} }));
    assert.throws(() => createHandler({ secret: 'x'.repeat(101), onNotification() {} }));
});
