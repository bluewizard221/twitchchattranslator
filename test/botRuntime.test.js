'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempRoot, writeJson, readJson } = require('./helpers');

const ROOT = useTempRoot();
const { createBot } = require('../lib/bot/runtime');

const BROADCASTER = '100';
const SECRET_TEXT = 'my very private chat line';

function setup(over) {
    const o = over || {};
    const tokensFile = path.join(ROOT, 'tokens-' + Math.random() + '.json');

    writeJson(tokensFile, { accessToken: 'u1', refreshToken: 'r1', expiresAt: o.expiresAt === undefined ? Date.now() + 3600e3 : o.expiresAt, userId: '200', login: 'botty' });

    const logs = [];
    const logger = {};
    for (const level of ['debug', 'info', 'warn', 'error']) { logger[level] = (m) => logs.push(level + ' ' + m); }

    const calls = { send: [], del: [], refresh: 0 };
    const api = {
        isLive: async () => (o.live === undefined ? false : o.live),
        sendChatMessage: async (b, s, m) => {
            calls.send.push({ b, s, m });
            if (o.sendStatus) { const e = new Error('x'); e.status = o.sendStatus; throw e; }
            return { sent: true, messageId: 'bot-' + calls.send.length };
        },
        deleteChatMessage: async (b, mod, id, token) => {
            calls.del.push({ id, token });
            if (o.deleteFirst401 && calls.del.length === 1) { const e = new Error('401'); e.status = 401; throw e; }
        },
        refreshUserToken: async () => { calls.refresh++; return { accessToken: 'u2', refreshToken: 'r2', expiresAt: Date.now() + 14400e3 }; }
    };
    const translate = {
        detect: async () => [{ language: 'en' }],
        translate: async (text, to) => [to === 'ja' ? '翻訳済み' : 'translated']
    };
    const usage = { added: 0, exceeded: (limit) => limit > 0 && usage.added >= limit, add: (n) => { usage.added += n; } };
    const lists = { read: (id) => ({ items: id === 'ignoreusers' ? ['nightbot'] : [], error: null }) };
    const bot = createBot({ config: { broadcasterId: BROADCASTER, coolDownCount: 5, dailyCharLimit: o.dailyCharLimit || 0 }, tokensFile, api, translate, lists, usage, logger });

    return { bot, calls, logs, usage, tokensFile };
}

let n = 0;
const chat = (login, text, extra) => Object.assign({
    broadcaster_user_id: BROADCASTER, chatter_user_id: login === 'caster' ? BROADCASTER : '5' + (++n), chatter_user_login: login,
    message_id: 'orig-' + (++n), badges: login === 'caster' ? [{ set_id: 'broadcaster' }] : [], message: { text, fragments: [{ type: 'text', text }] }
}, extra || {});

test('配信外: チャンネル主は翻訳して Helix で投稿、視聴者は翻訳しない。配信が始まれば視聴者も翻訳', async () => {
    const { bot, calls } = setup({ live: false });

    await bot.start();
    assert.strictEqual((await bot.handleEvent('channel.chat.message', chat('caster', 'good morning'))).result, 'translated');
    assert.deepStrictEqual(calls.send[0], { b: BROADCASTER, s: '200', m: '翻訳済み (source lang: en)' });
    assert.strictEqual((await bot.handleEvent('channel.chat.message', chat('viewer1', 'hello'))).reason, 'offline');

    await bot.handleEvent('stream.online', { broadcaster_user_id: BROADCASTER });
    assert.strictEqual((await bot.handleEvent('channel.chat.message', chat('viewer1', 'hello'))).result, 'translated');

    await bot.handleEvent('stream.offline', { broadcaster_user_id: BROADCASTER });
    assert.strictEqual((await bot.handleEvent('channel.chat.message', chat('viewer1', 'hello again'))).reason, 'offline');
});

test('配信状態が取れなければ、全員の発言を翻訳する（取れるまで）', async () => {
    const { bot } = setup();

    bot.state.streamLive = null;
    assert.strictEqual((await bot.handleEvent('channel.chat.message', chat('viewer9', 'hi'))).result, 'translated');
});

test('元の発言が削除されたら翻訳も削除し、BAN・タイムアウトならその人の翻訳をすべて削除する', async () => {
    const { bot, calls } = setup({ live: true });

    await bot.start();
    const a = chat('troll', 'one');
    const b = chat('troll', 'two');
    const c = chat('nice', 'three');

    for (const e of [a, b, c]) { await bot.handleEvent('channel.chat.message', e); }

    assert.deepStrictEqual(await bot.handleEvent('channel.chat.message_delete', { broadcaster_user_id: BROADCASTER, message_id: c.message_id }), { deleted: 1 });
    assert.deepStrictEqual(await bot.handleEvent('channel.chat.clear_user_messages', { broadcaster_user_id: BROADCASTER, target_user_login: 'troll', target_user_id: '1' }), { deleted: 2 });
    assert.deepStrictEqual(calls.del.map((d) => d.id).sort(), ['bot-1', 'bot-2', 'bot-3']);
    assert.deepStrictEqual(await bot.handleEvent('channel.chat.message_delete', { broadcaster_user_id: BROADCASTER, message_id: 'unknown' }), { deleted: 0 });
});

test('削除で 401 ならトークンを更新してやり直し、更新したトークンをファイルに保存する', async () => {
    const { bot, calls, tokensFile } = setup({ live: true, deleteFirst401: true });
    const e = chat('someone', 'hi');

    await bot.start();
    await bot.handleEvent('channel.chat.message', e);
    await bot.handleEvent('channel.chat.message_delete', { broadcaster_user_id: BROADCASTER, message_id: e.message_id });

    assert.deepStrictEqual(calls.del.map((d) => d.token), ['u1', 'u2']);
    assert.strictEqual(readJson(tokensFile).accessToken, 'u2');
    assert.strictEqual(fs.statSync(tokensFile).mode & 0o777, 0o600);
});

test('期限切れのトークンは削除の前に更新する', async () => {
    const { bot, calls } = setup({ live: true, expiresAt: Date.now() - 1 });
    const e = chat('someone', 'hi');

    await bot.start();
    await bot.handleEvent('channel.chat.message', e);
    await bot.handleEvent('channel.chat.message_delete', { broadcaster_user_id: BROADCASTER, message_id: e.message_id });
    assert.strictEqual(calls.refresh, 1);
    assert.strictEqual(calls.del[0].token, 'u2');
});

test('Helix が 403 なら IRC には投稿せず、理由をログに残す', async () => {
    const { bot, logs } = setup({ live: true, sendStatus: 403 });

    await bot.start();
    assert.strictEqual((await bot.handleEvent('channel.chat.message', chat('v', 'hi'))).reason, 'send_failed');
    assert.ok(logs.some((l) => l.startsWith('error') && l.includes('channel:bot') && l.includes('IRC での代替投稿はしません')));
});

test('1 日の上限に達したら翻訳しない（記録は 1 日 1 回）', async () => {
    const { bot, usage, logs } = setup({ live: true, dailyCharLimit: 10 });

    await bot.start();
    assert.strictEqual((await bot.handleEvent('channel.chat.message', chat('v', 'hello world'))).result, 'translated');
    assert.strictEqual(usage.added, 22, 'detect と translate の両方を数える');
    assert.strictEqual((await bot.handleEvent('channel.chat.message', chat('v2', 'more'))).reason, 'daily_limit');
    assert.strictEqual((await bot.handleEvent('channel.chat.message', chat('v3', 'more'))).reason, 'daily_limit');
    assert.strictEqual(logs.filter((l) => l.includes('上限')).length, 1);
});

test('別のチャンネルのイベントと未対応のイベントは無視する', async () => {
    const { bot, calls } = setup({ live: true });

    await bot.start();
    assert.strictEqual((await bot.handleEvent('channel.chat.message', chat('v', 'hi', { broadcaster_user_id: '999' }))).reason, 'other_channel');
    assert.strictEqual((await bot.handleEvent('channel.follow', { broadcaster_user_id: BROADCASTER })).reason, 'unsupported');
    assert.strictEqual(calls.send.length, 0);
});

test('ログには視聴者の発言の本文を書かない（D19）', async () => {
    const { bot, logs } = setup({ live: true });

    bot.state.streamLive = true;
    await bot.start();
    await bot.handleEvent('channel.chat.message', chat('v', SECRET_TEXT));
    await bot.handleEvent('channel.chat.message', chat('nightbot', SECRET_TEXT));
    await bot.handleEvent('channel.chat.message', chat('v', '!' + SECRET_TEXT));

    assert.ok(logs.length > 0);
    assert.ok(logs.every((l) => !l.includes(SECRET_TEXT) && !l.includes('private')), logs.join('\n'));
});
