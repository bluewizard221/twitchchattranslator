'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const bot = require('../web/lib/bot');

/** process の代わり（IPC の口だけ） */
function fakeChannel(reply) {
    const channel = new EventEmitter();

    channel.connected = true;
    channel.sent = [];
    channel.send = (msg) => {
        channel.sent.push(msg);
        setImmediate(() => channel.emit('message', reply(msg)));
    };

    return channel;
}

test('管理プロセスに依頼し、応答を返す', async () => {
    const channel = fakeChannel((msg) => ({ type: 'response', id: msg.id, ok: true, result: { echo: msg.action, payload: msg.payload } }));
    const client = bot.createManagerClient(channel);

    assert.strictEqual(client.available(), true);
    assert.deepStrictEqual(await client.request('channel.stop', { login: 'alice' }), { echo: 'channel.stop', payload: { login: 'alice' } });
});

test('管理プロセスのエラーは例外になる', async () => {
    const channel = fakeChannel((msg) => ({ type: 'response', id: msg.id, ok: false, error: '登録されていないチャンネルです' }));
    const client = bot.createManagerClient(channel);

    await assert.rejects(client.request('channel.stop', { login: 'x' }), /登録されていない/);
});

test('切断されていれば使えない', async () => {
    const channel = fakeChannel(() => ({}));

    channel.connected = false;

    const client = bot.createManagerClient(channel);

    assert.strictEqual(client.available(), false);
    await assert.rejects(client.request('status'), /接続されていません/);
});

test('管理プロセスなしで起動したときの代わりは、どの依頼も分かりやすく失敗する', async () => {
    const none = bot.unavailableManager();

    assert.strictEqual(none.available(), false);
    await assert.rejects(none.request('status'), /manager\.js/);
});
