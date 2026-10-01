'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { BoundedMemoryStore } = require('../web/lib/sessionStore');

function promisify(store, method, ...args) {
    return new Promise((resolve, reject) => store[method](...args, (err, value) => (err ? reject(err) : resolve(value))));
}

function makeStore(options) {
    let now = 1_000_000;
    const store = new BoundedMemoryStore(Object.assign({ pruneIntervalMs: 0, now: () => now }, options));

    return { store, advance: (ms) => { now += ms; }, at: () => now };
}

const userSession = (login, expiresInMs, base) => ({ user: { login }, cookie: { expires: new Date(base + expiresInMs).toISOString() } });

test('保存・取得・破棄ができる', async () => {
    const { store, at } = makeStore();

    await promisify(store, 'set', 's1', userSession('a', 3600e3, at()));
    assert.strictEqual((await promisify(store, 'get', 's1')).user.login, 'a');

    await promisify(store, 'destroy', 's1');
    assert.strictEqual(await promisify(store, 'get', 's1'), null);
});

test('未ログインのセッションは短い期限で消える', async () => {
    const { store, advance } = makeStore({ anonymousTtlMs: 10 * 60e3 });

    await promisify(store, 'set', 'anon', { oauthState: 'x', cookie: {} });
    advance(9 * 60e3);
    assert.ok(await promisify(store, 'get', 'anon'));
    advance(2 * 60e3);
    assert.strictEqual(await promisify(store, 'get', 'anon'), null);
});

test('ログイン済みのセッションは Cookie の期限まで残る', async () => {
    const { store, advance, at } = makeStore();

    await promisify(store, 'set', 's', userSession('a', 12 * 3600e3, at()));
    advance(11 * 3600e3);
    assert.ok(await promisify(store, 'get', 's'));
    advance(2 * 3600e3);
    assert.strictEqual(await promisify(store, 'get', 's'), null);
});

test('上限に達したら、未ログインのセッションから追い出す', async () => {
    const { store, at } = makeStore({ maxSessions: 3 });

    await promisify(store, 'set', 'user1', userSession('a', 3600e3, at()));
    await promisify(store, 'set', 'anon1', { cookie: {} });
    await promisify(store, 'set', 'user2', userSession('b', 3600e3, at()));
    await promisify(store, 'set', 'anon2', { cookie: {} });

    assert.strictEqual(await promisify(store, 'length'), 3);
    assert.strictEqual(await promisify(store, 'get', 'anon1'), null);
    assert.ok(await promisify(store, 'get', 'user1'));
    assert.ok(await promisify(store, 'get', 'user2'));
});

test('大量の未ログインのアクセスでも件数は上限を超えない', async () => {
    const { store, at } = makeStore({ maxSessions: 50 });

    await promisify(store, 'set', 'user1', userSession('a', 3600e3, at()));
    for (let i = 0; i < 1000; i++) {
        await promisify(store, 'set', 'anon' + i, { cookie: {} });
    }

    assert.strictEqual(await promisify(store, 'length'), 50);
    assert.ok(await promisify(store, 'get', 'user1'), 'ログイン済みのセッションは残る');
});

test('ユーザー単位でセッションを無効にできる（チャンネルの削除時）', async () => {
    const { store, at } = makeStore();

    await promisify(store, 'set', 'a1', userSession('Streamer_A', 3600e3, at()));
    await promisify(store, 'set', 'a2', userSession('streamer_a', 3600e3, at()));
    await promisify(store, 'set', 'b1', userSession('streamer_b', 3600e3, at()));

    assert.strictEqual(store.destroyByLogin('streamer_a'), 2);
    assert.strictEqual(await promisify(store, 'get', 'a1'), null);
    assert.ok(await promisify(store, 'get', 'b1'));
});
