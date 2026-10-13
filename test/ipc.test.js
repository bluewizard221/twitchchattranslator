'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createClient, createServer } = require('../lib/ipc');

function pair(handlers) {
    const childSide = new EventEmitter();
    const server = createServer(handlers, (name, msg) => setImmediate(() => childSide.emit('message', msg)));

    childSide.connected = true;
    childSide.send = (msg) => setImmediate(() => server('web', msg));

    return createClient(childSide, { timeoutMs: 300 });
}

test('要求に対する応答を受け取れる', async () => {
    const client = pair({ add: async (p) => p.a + p.b });

    assert.strictEqual(await client.request('add', { a: 2, b: 3 }), 5);
});

test('処理のエラーと未知の操作は reject になる', async () => {
    const client = pair({ fail: async () => { throw new Error('だめ'); } });

    await assert.rejects(() => client.request('fail'), /だめ/);
    await assert.rejects(() => client.request('nope'), /不明な操作/);
});

test('応答がなければ時間切れになる', async () => {
    const childSide = new EventEmitter();

    childSide.connected = true;
    childSide.send = () => {};

    await assert.rejects(() => createClient(childSide, { timeoutMs: 50 }).request('x'), /応答がありません/);
});

test('管理プロセスの外で起動したときは、すぐにエラーになる', async () => {
    await assert.rejects(() => createClient(new EventEmitter()).request('x'), /接続されていません/);
});
