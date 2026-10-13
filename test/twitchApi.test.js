'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createTwitchApi } = require('../lib/twitchApi');

/** 呼び出しを記録し、URL に応じた応答を返す fetch */
function fakeFetch(routes) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url, init });
        for (const [prefix, handler] of routes) {
            if (url.startsWith(prefix)) {
                const r = typeof handler === 'function' ? handler(url, init, calls) : handler;
                const text = r.body === undefined ? '' : JSON.stringify(r.body);
                return { ok: r.status < 400, status: r.status, text: async () => text };
            }
        }
        throw new Error('unexpected ' + url);
    };
    fn.calls = calls;
    return fn;
}

const TOKEN = 'https://id.twitch.tv/oauth2/token';

test('App Access Token は期限の手前まで使い回す', async () => {
    let now = 0;
    let issued = 0;
    const fetch = fakeFetch([[TOKEN, () => ({ status: 200, body: { access_token: 'app' + (++issued), expires_in: 3600 } })]]);
    const api = createTwitchApi({ clientId: 'cid', clientSecret: 'sec', fetch, now: () => now });

    assert.strictEqual(await api.getAppToken(), 'app1');
    now += 3000e3;
    assert.strictEqual(await api.getAppToken(), 'app1');
    now += 400e3;                                   // 期限の 5 分前を過ぎた
    assert.strictEqual(await api.getAppToken(), 'app2');
});

test('Helix が 401 を返したら App Access Token を取り直して 1 回だけやり直す', async () => {
    let issued = 0;
    let helixCalls = 0;
    const fetch = fakeFetch([
        [TOKEN, () => ({ status: 200, body: { access_token: 'app' + (++issued), expires_in: 3600 } })],
        ['https://api.twitch.tv/helix/streams', (url, init) => {
            helixCalls++;
            return init.headers.Authorization === 'Bearer app1' ? { status: 401, body: {} } : { status: 200, body: { data: [{ type: 'live' }] } };
        }]
    ]);
    const api = createTwitchApi({ clientId: 'cid', clientSecret: 'sec', fetch });

    assert.strictEqual(await api.isLive('123'), true);
    assert.strictEqual(helixCalls, 2);
    assert.strictEqual(issued, 2);
});

test('投稿: 送信の結果と bot のメッセージ ID を返す。ヘッダーと本文が正しい', async () => {
    const fetch = fakeFetch([
        [TOKEN, { status: 200, body: { access_token: 'app', expires_in: 3600 } }],
        ['https://api.twitch.tv/helix/chat/messages', { status: 200, body: { data: [{ message_id: 'm1', is_sent: true }] } }]
    ]);
    const api = createTwitchApi({ clientId: 'cid', clientSecret: 'sec', fetch });
    const result = await api.sendChatMessage('100', '200', 'hello');
    const call = fetch.calls.find((c) => c.url.includes('/chat/messages'));

    assert.deepStrictEqual(result, { sent: true, messageId: 'm1', dropReason: null });
    assert.strictEqual(call.init.headers['Client-Id'], 'cid');
    assert.deepStrictEqual(JSON.parse(call.init.body), { broadcaster_id: '100', sender_id: '200', message: 'hello' });
});

test('投稿で 403 なら status 付きのエラーになる（呼び出し側で理由を記録する）', async () => {
    const fetch = fakeFetch([
        [TOKEN, { status: 200, body: { access_token: 'app', expires_in: 3600 } }],
        ['https://api.twitch.tv/helix/chat/messages', { status: 403, body: { message: 'forbidden' } }]
    ]);
    const api = createTwitchApi({ clientId: 'cid', clientSecret: 'sec', fetch });

    await assert.rejects(() => api.sendChatMessage('1', '2', 'x'), (err) => err.status === 403 && err.body.message === 'forbidden');
});

test('購読の一覧はページをすべてたどる', async () => {
    const fetch = fakeFetch([
        [TOKEN, { status: 200, body: { access_token: 'app', expires_in: 3600 } }],
        ['https://api.twitch.tv/helix/eventsub/subscriptions', (url) => (url.includes('after=c1')
            ? { status: 200, body: { data: [{ id: 'b' }], pagination: {} } }
            : { status: 200, body: { data: [{ id: 'a' }], pagination: { cursor: 'c1' } } })]
    ]);
    const api = createTwitchApi({ clientId: 'cid', clientSecret: 'sec', fetch });

    assert.deepStrictEqual((await api.listSubscriptions()).map((s) => s.id), ['a', 'b']);
});

test('ユーザートークンの更新と、無効化（失敗しても例外にしない）', async () => {
    const fetch = fakeFetch([
        [TOKEN, (url, init) => {
            const params = new URLSearchParams(init.body);
            assert.strictEqual(params.get('grant_type'), 'refresh_token');
            return { status: 200, body: { access_token: 'new', refresh_token: 'r2', expires_in: 14400, scope: ['user:bot'] } };
        }],
        ['https://id.twitch.tv/oauth2/revoke', { status: 400, body: { message: 'invalid token' } }]
    ]);
    const api = createTwitchApi({ clientId: 'cid', clientSecret: 'sec', fetch, now: () => 1000 });
    const fresh = await api.refreshUserToken('r1');

    assert.deepStrictEqual(fresh, { accessToken: 'new', refreshToken: 'r2', expiresAt: 1000 + 14400e3, scopes: ['user:bot'] });
    assert.strictEqual(await api.revokeToken('x'), false);
});
