'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Supervisor } = require('../lib/supervisor');

const FAKE = path.join(__dirname, 'fixtures', 'fake-child.js');
const spec = (mode) => ({ command: process.execPath, args: [FAKE], env: Object.assign({}, process.env, { FAKE_MODE: mode }) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs) {
    const until = Date.now() + (timeoutMs || 5000);

    while (Date.now() < until) {
        if (fn()) { return true; }
        await sleep(20);
    }
    return false;
}

test('起動して running になり、stop で SIGTERM を送って止まる', async () => {
    const sup = new Supervisor();

    sup.start('a', spec('run'));
    assert.ok(await waitFor(() => sup.status('a').state === 'running'));
    await sleep(100);                  // 子プロセスが SIGTERM のハンドラーを登録するのを待つ

    await sup.stop('a');
    assert.strictEqual(sup.status('a').state, 'stopped');
    assert.strictEqual(sup.status('a').lastExit.code, 0);
});

test('異常終了したら間隔をあけて起動し直し、間隔は倍々に伸びる', async () => {
    const sup = new Supervisor({ minBackoffMs: 40, maxBackoffMs: 160 });

    sup.start('c', spec('crash'));
    assert.ok(await waitFor(() => sup.status('c').restarts >= 4, 5000));

    const child = sup.children.get('c');

    assert.strictEqual(child.backoffMs, 160, '上限で止まる');
    await sup.stop('c');
    const restarts = sup.status('c').restarts;

    await sleep(300);
    assert.strictEqual(sup.status('c').restarts, restarts, '止めたあとは起動し直さない');
});

test('しばらく安定して動いたら、再起動の間隔を元に戻す', async () => {
    const sup = new Supervisor({ minBackoffMs: 30, stableAfterMs: 200 });

    sup.start('s', spec('run'));
    assert.ok(await waitFor(() => sup.status('s').state === 'running'));

    const child = sup.children.get('s');

    child.backoffMs = 9999;            // 何度も落ちたあとの状態を作る
    await sleep(250);                  // 安定して動く
    sup.signal('s', 'SIGKILL');        // 落とす
    assert.ok(await waitFor(() => sup.status('s').state === 'running' && sup.status('s').restarts === 1, 3000));
    await sup.stop('s');
});

test('SIGTERM を無視する子プロセスは、猶予の後に SIGKILL で止める', async () => {
    const sup = new Supervisor({ stopTimeoutMs: 200 });

    sup.start('x', spec('stubborn'));
    assert.ok(await waitFor(() => sup.status('x').state === 'running'));
    await sleep(100);                  // SIGTERM のハンドラーが登録されるのを待つ

    const started = Date.now();

    await sup.stop('x');
    assert.strictEqual(sup.status('x').lastExit.signal, 'SIGKILL');
    assert.ok(Date.now() - started >= 150);
});

test('IPC で送受信できる', async () => {
    const sup = new Supervisor();
    const got = new Promise((resolve) => sup.on('message', (name, msg) => { if (msg.type === 'pong') { resolve([name, msg]); } }));

    sup.start('i', spec('run'));
    assert.ok(await waitFor(() => sup.status('i').state === 'running'));
    await sleep(100);
    assert.strictEqual(sup.send('i', { type: 'ping' }), true);

    const [name] = await got;

    assert.strictEqual(name, 'i');
    await sup.stop('i');
    assert.strictEqual(sup.send('i', { type: 'ping' }), false, '止まっている子には送れない');
});
