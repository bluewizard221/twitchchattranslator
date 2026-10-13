'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { useTempRoot, writeJson, readJson } = require('./helpers');

const ROOT = useTempRoot();

const paths = require('../lib/paths');
const channels = require('../lib/channels');
const { Supervisor } = require('../lib/supervisor');
const { createManager } = require('../manager');

const FAKE = path.join(__dirname, 'fixtures', 'fake-child.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = { info() {}, warn() {}, error() {} };

async function waitFor(fn, timeoutMs) {
    const until = Date.now() + (timeoutMs || 5000);

    while (Date.now() < until) {
        if (await fn()) { return true; }
        await sleep(25);
    }
    return false;
}

function makeReady(login) {
    channels.create(login);
    const p = paths.channel(login);

    writeJson(p.localConfig, { config: { twitchChannel: login, twitchBroadcasterId: '9' + login.length } });
    fs.writeFileSync(p.botTokens, '{}', { mode: 0o600 });
    fs.writeFileSync(p.googleKey, '{}', { mode: 0o600 });
}

function getJson(port) {
    return new Promise((resolve, reject) => {
        // 接続を使い回さない（前のテストで止めた管理プロセスへの古い接続を再利用しないように）
        http.get({ host: '127.0.0.1', port, path: '/healthz', agent: false }, (res) => {
            let body = '';

            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }).on('error', reject);
    });
}

// 共通の設定（pidFile は絶対パス。チャンネルごとに上書きされることを確かめる）
writeJson(path.join(ROOT, 'config', 'default.json'), { config: { pidFile: '/app/twitchchattranslator.pid', coolDownCount: 5, googleKeyFile: '/shared/key.json' } });

makeReady('ready_one');
makeReady('ready_two');
channels.create('not_ready');
makeReady('disabled_one');
channels.setEnabled('disabled_one', false);

const HEALTH_PORT = 39000 + Math.floor(Math.random() * 1000);

function newManager(mode, extra) {
    return createManager(Object.assign({
        logger: quiet,
        supervisor: new Supervisor({ minBackoffMs: 50, stopTimeoutMs: 500 }),
        botScript: FAKE,
        webScript: FAKE,
        botEnv: { FAKE_MODE: mode },
        webEnv: { FAKE_MODE: 'run' },
        healthPort: HEALTH_PORT,
        healthHost: '127.0.0.1',
        emoteIntervalMs: 0,
        logRetentionDays: 0
    }, extra || {}));
}

test('起動するのは「有効」かつ「準備がそろった」チャンネルだけ。管理画面も起動する', async () => {
    const manager = newManager('run');

    await manager.start();

    try {
        assert.deepStrictEqual(manager.supervisor.names().sort(), ['bot:ready_one', 'bot:ready_two', 'web']);

        const st = manager.status();

        assert.deepStrictEqual(st.bots.not_ready.missing, ['bot アカウントの接続', 'Google Cloud のキー', '配信者の ID']);
        assert.strictEqual(st.bots.disabled_one.enabled, false);
    } finally {
        await manager.stop();
    }
});

test('bot はチャンネルのディレクトリで、チャンネル固有の値を固定して起動する', async () => {
    const manager = newManager('run');
    const spec = manager.botSpec('ready_one');
    const p = paths.channel('ready_one');

    assert.strictEqual(spec.cwd, p.root);
    assert.strictEqual(spec.env.TCT_CHANNEL, 'ready_one');
    assert.strictEqual(spec.env.NODE_CONFIG_DIR, paths.CONFIG_DIR + path.delimiter + p.configDir);

    // node-config で実際に読ませて、共通の設定より優先されることを確かめる
    const child = spawn(process.execPath, [FAKE], { cwd: spec.cwd, env: Object.assign({}, spec.env, { FAKE_MODE: 'config' }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const msg = await new Promise((resolve) => child.on('message', (m) => { if (m.type === 'config') { resolve(m); } }));

    child.kill('SIGTERM');
    assert.strictEqual(msg.config.pidFile, p.pidFile);
    assert.strictEqual(msg.config.googleKeyFile, p.googleKey);
    assert.strictEqual(msg.config.twitchChannel, 'ready_one');
    assert.strictEqual(msg.config.coolDownCount, 5, '共通の設定も読める');
});

test('スクリプトはデータの置き場所（TCT_ROOT）ではなく、コードの場所から起動する', () => {
    const manager = createManager({ logger: quiet, healthPort: 0, emoteIntervalMs: 0, logRetentionDays: 0 });
    const repo = path.resolve(__dirname, '..');

    assert.notStrictEqual(paths.ROOT, repo, '前提: テストでは TCT_ROOT が別の場所');
    assert.strictEqual(manager.botSpec('ready_one').args[0], path.join(repo, 'twitchchattranslator.js'));
    assert.ok(fs.existsSync(manager.botSpec('ready_one').args[0]));
});

test('状態を返す口: すべて動いていれば 200、動かすべき bot が落ち続けていれば 503', async () => {
    const ok = newManager('run');

    await ok.start();
    try {
        assert.ok(await waitFor(async () => (await getJson(HEALTH_PORT)).status === 200));
    } finally {
        await ok.stop();
    }

    const bad = newManager('crash');

    await bad.start();
    try {
        // 起動直後の一瞬は「動いている」ので、落ちて再起動待ちになるまで待つ
        assert.ok(await waitFor(async () => (await getJson(HEALTH_PORT)).status === 503));

        const res = await getJson(HEALTH_PORT);

        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.status, 'error');
        assert.ok(res.body.bots.ready_one.process.restarts >= 0);
    } finally {
        await bad.stop();
    }
});

test('管理画面からの操作: 停止・起動・チャンネル追加の反映・未登録は拒否', async () => {
    const manager = newManager('run');

    await manager.start();

    try {
        await manager.handlers['channel.stop']({ login: 'ready_one' });
        assert.strictEqual(channels.isEnabled('ready_one'), false);
        assert.ok(!manager.supervisor.names().includes('bot:ready_one'));

        await manager.handlers['channel.start']({ login: 'ready_one' });
        assert.ok(manager.supervisor.names().includes('bot:ready_one'));

        makeReady('added_later');
        await manager.handlers['channels.changed']({});
        assert.ok(manager.supervisor.names().includes('bot:added_later'));

        await assert.rejects(() => manager.handlers['channel.start']({ login: 'nobody_here' }), /登録されていない/);
        await assert.rejects(() => manager.handlers['channel.start']({ login: '../config' }), /登録されていない/);
    } finally {
        await manager.stop();
        channels.removeFiles('added_later');
    }
});

test('エモートの更新: チャンネルのファイルに書き、bot に SIGHUP を送る。全部失敗したら変えない', async () => {
    let fail = false;
    const manager = newManager('run', {
        fetchEmoteNames: async () => (fail
            ? { names: [], sources: [{ ok: false }], warnings: ['down'] }
            : { names: ['EmoteA', 'EmoteB'], sources: [{ ok: true }], warnings: [] })
    });

    await manager.start();

    try {
        assert.ok(await waitFor(() => manager.supervisor.status('bot:ready_one').state === 'running'));
        await sleep(150);

        const hup = new Promise((resolve) => manager.supervisor.on('message', (name, msg) => { if (msg.type === 'hup' && name === 'bot:ready_one') { resolve(true); } }));
        const result = await manager.refreshEmotes('ready_one');

        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(readJson(paths.channel('ready_one').emoticons), { emoticons: ['EmoteA', 'EmoteB'] });
        assert.deepStrictEqual(readJson(paths.channel('ready_two').emoticons), { emoticons: [] }, 'ほかのチャンネルは変わらない');
        assert.strictEqual(await hup, true);

        fail = true;
        assert.strictEqual((await manager.refreshEmotes('ready_one')).ok, false);
        assert.deepStrictEqual(readJson(paths.channel('ready_one').emoticons), { emoticons: ['EmoteA', 'EmoteB'] });
    } finally {
        await manager.stop();
    }
});

test('止めるときは bot をすべて止めてから管理画面を止める', async () => {
    const manager = newManager('run');
    const order = [];

    manager.supervisor.on('exit', (name) => order.push(name));
    await manager.start();
    assert.ok(await waitFor(() => manager.status().status === 'ok'));
    await manager.stop();

    assert.strictEqual(order[order.length - 1], 'web');
    assert.strictEqual(order.filter((n) => n.startsWith('bot:')).length, 2);
});

test('30 日を過ぎた過去のログだけを削除し、当日分は残す', () => {
    const manager = newManager('run', { logRetentionDays: 30 });
    const dir = paths.channel('ready_one').logDir;
    const old = new Date(Date.now() - 31 * 86400e3);
    const files = {
        'twitchchattranslator.log': false,
        'twitchchattranslator.log.20260801.gz': true,
        'twitchchattranslator.log.20260930.gz': false,
        'notes.txt': false
    };

    for (const name of Object.keys(files)) {
        const file = path.join(dir, name);

        fs.writeFileSync(file, 'x');
        if (name !== 'twitchchattranslator.log.20260930.gz') { fs.utimesSync(file, old, old); }
    }

    manager.pruneLogs();

    for (const [name, removed] of Object.entries(files)) {
        assert.strictEqual(fs.existsSync(path.join(dir, name)), !removed, name);
    }
});
