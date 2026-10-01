'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempRoot, writeJson } = require('./helpers');

const ROOT = useTempRoot();

const paths = require('../lib/paths');
const channels = require('../lib/channels');
const { Supervisor } = require('../lib/supervisor');
const { sign } = require('../lib/eventsub');
const { createManager } = require('../manager');

const FAKE = path.join(__dirname, 'fixtures', 'fake-child.js');
const SECRET = 'eventsub-secret-for-tests';
const CB = 'https://translate.example/eventsub/callback';
const PORT = 38000 + Math.floor(Math.random() * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error() {} };

function makeReady(login, broadcasterId, botId) {
    channels.create(login);
    const p = paths.channel(login);

    writeJson(p.localConfig, { config: { twitchChannel: login, twitchBroadcasterId: broadcasterId } });
    writeJson(p.botTokens, { accessToken: 'x', refreshToken: 'y', userId: botId, login: login + '_bot' });
    fs.writeFileSync(p.googleKey, '{}');
}

makeReady('chan_a', '111', '911');
makeReady('chan_b', '222', '922');

function fakeApi() {
    const created = [];
    return {
        created,
        getAppToken: async () => 'app-token-1',
        appTokenInfo: () => ({ token: 'app-token-1', expiresAt: 123 }),
        listSubscriptions: async () => [],
        deleteSubscription: async () => {},
        createSubscription: async (type, version, condition) => { created.push({ type, condition }); }
    };
}

async function postEvent(type, event, opts) {
    const raw = JSON.stringify({ subscription: { id: 's', type, version: '1', status: 'enabled' }, event });
    const id = 'm-' + Math.random();
    const ts = new Date().toISOString();

    return fetch('http://127.0.0.1:' + PORT + '/eventsub/callback', {
        method: 'POST',
        headers: {
            'Twitch-Eventsub-Message-Id': id, 'Twitch-Eventsub-Message-Timestamp': ts,
            'Twitch-Eventsub-Message-Signature': sign((opts && opts.secret) || SECRET, id, ts, raw),
            'Twitch-Eventsub-Message-Type': 'notification'
        },
        body: raw
    });
}

test('署名付きの Webhook を、配信者の ID に対応するチャンネルの bot だけに渡す。App Access Token も配る', async () => {
    const api = fakeApi();
    const manager = createManager({
        logger: quiet,
        supervisor: new Supervisor({ minBackoffMs: 50, stopTimeoutMs: 500 }),
        botScript: FAKE, botEnv: { FAKE_MODE: 'run' }, startWeb: false,
        healthPort: 0, emoteIntervalMs: 0, logRetentionDays: 0, subscriptionIntervalMs: 0,
        eventsubPort: PORT, eventsubHost: '127.0.0.1',
        twitchApi: api, shared: { eventsubCallbackUrl: CB, eventsubSecret: SECRET }
    });
    const received = [];

    manager.supervisor.on('message', (name, msg) => { if (msg.type === 'got') { received.push([name, msg.what, msg.payload]); } });
    await manager.start();

    try {
        await sleep(400);

        // 起動した bot に App Access Token が届く
        assert.ok(received.some(([name, what]) => name === 'bot:chan_a' && what === 'app-token'));
        assert.ok(received.some(([name, what]) => name === 'bot:chan_b' && what === 'app-token'));

        // チャンネル A のイベントは A の bot にだけ届く
        assert.strictEqual((await postEvent('channel.chat.message', { broadcaster_user_id: '111', message_id: 'a1' })).status, 204);
        // 署名が違うものは誰にも届かない
        assert.strictEqual((await postEvent('channel.chat.message', { broadcaster_user_id: '222', message_id: 'bad' }, { secret: 'wrong-secret-12345' })).status, 403);
        // 登録されていない配信者のイベントは破棄して数える
        await postEvent('stream.online', { broadcaster_user_id: '333' });
        await sleep(200);

        const events = received.filter(([, what]) => what === 'eventsub');

        assert.deepStrictEqual(events.map(([name, , p]) => [name, p.event.message_id]), [['bot:chan_a', 'a1']]);
        assert.strictEqual(manager.status().eventsub.dropped, 1);

        // 購読の突き合わせ: 2 チャンネル × 5 種類
        const result = await manager.syncSubscriptions();

        assert.strictEqual(result.created, 10);
        assert.ok(api.created.some((c) => c.type === 'channel.chat.message' && c.condition.broadcaster_user_id === '222' && c.condition.user_id === '922'));
        assert.strictEqual(manager.status().eventsub.configured, true);
    } finally {
        await manager.stop();
    }
});

test('Twitch アプリや受信口が未設定なら、EventSub だけを止めて管理プロセスは動く', async () => {
    const warnings = [];
    const manager = createManager({
        logger: { info() {}, error() {}, warn: (m) => warnings.push(m) },
        supervisor: new Supervisor({ minBackoffMs: 50, stopTimeoutMs: 500 }),
        botScript: FAKE, botEnv: { FAKE_MODE: 'run' }, startWeb: false,
        healthPort: 0, emoteIntervalMs: 0, logRetentionDays: 0,
        eventsubPort: PORT, eventsubHost: '127.0.0.1',
        shared: { twitchClientId: '', twitchClientSecret: '', eventsubCallbackUrl: '', eventsubSecret: '' }
    });

    await manager.start();
    try {
        assert.strictEqual(manager.status().eventsub.configured, false);
        assert.ok(warnings.some((w) => w.includes('EventSub は無効')));
        assert.strictEqual(await manager.syncSubscriptions(), null);
        await assert.rejects(() => fetch('http://127.0.0.1:' + PORT + '/eventsub/callback', { method: 'POST' }));
    } finally {
        await manager.stop();
    }
});
