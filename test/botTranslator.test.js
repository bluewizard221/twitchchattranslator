'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decide, Cooldown, removeEmotes } = require('../lib/bot/translator');

const BROADCASTER = '100';
const BOT = '200';
let n = 0;

function msg(who, text, extra) {
    const base = who === 'caster'
        ? { chatter_user_id: BROADCASTER, chatter_user_login: 'caster', badges: [{ set_id: 'broadcaster', id: '1' }] }
        : who === 'mod'
            ? { chatter_user_id: '300', chatter_user_login: 'moddy', badges: [{ set_id: 'moderator', id: '1' }] }
            : who === 'bot'
                ? { chatter_user_id: BOT, chatter_user_login: 'botty', badges: [] }
                : { chatter_user_id: '4' + (++n), chatter_user_login: 'viewer' + n, badges: [] };

    return Object.assign({ broadcaster_user_id: BROADCASTER, message_id: 'm' + (++n), message: { text, fragments: [{ type: 'text', text }] } }, base, extra || {});
}

function ctx(over) {
    return Object.assign({
        broadcasterId: BROADCASTER, botUserId: BOT,
        lists: { ignoreUsers: ['nightbot'], ignoreLines: ['^https?://'], emotes: ['LUL', 'monkaS'] },
        streamLive: null, cooldown: new Cooldown(() => 0), coolDownCount: 5
    }, over || {});
}

test('ハーネスと同じ: 配信外はチャンネル主だけ翻訳、配信中は全員、状態不明なら全員', () => {
    assert.strictEqual(decide(msg('caster', 'good morning'), ctx({ streamLive: false })).action, 'translate');
    assert.deepStrictEqual(decide(msg('viewer', 'hello world'), ctx({ streamLive: false })), { action: 'ignore', reason: 'offline' });
    assert.strictEqual(decide(msg('viewer', 'hello world'), ctx({ streamLive: true })).action, 'translate');
    assert.strictEqual(decide(msg('viewer', 'hello world'), ctx({ streamLive: null })).action, 'translate');
});

test('bot 自身の発言と、共有チャットでほかのチャンネルから来た発言は無視', () => {
    assert.strictEqual(decide(msg('bot', 'hi'), ctx()).reason, 'self');
    assert.strictEqual(decide(msg('viewer', 'hi', { source_broadcaster_user_id: '999' }), ctx()).reason, 'shared_chat_other_channel');
    assert.strictEqual(decide(msg('viewer', 'hi', { source_broadcaster_user_id: BROADCASTER }), ctx()).action, 'translate');
    assert.strictEqual(decide(msg('viewer', 'hi', { source_broadcaster_user_id: null }), ctx()).action, 'translate');
});

test('コマンド: チャンネル主とモデレーターだけ。視聴者のコマンドとほかの ! は無視（配信外でも動く）', () => {
    assert.deepStrictEqual(decide(msg('mod', '!refreshemoticons'), ctx({ streamLive: false })), { action: 'command', list: 'emoticons' });
    assert.deepStrictEqual(decide(msg('caster', '!refreshignoreuser'), ctx()), { action: 'command', list: 'ignoreusers' });
    assert.strictEqual(decide(msg('viewer', '!refreshignoreline'), ctx()).reason, 'command_not_permitted');
    assert.strictEqual(decide(msg('viewer', '!so someone'), ctx()).reason, 'command');
});

test('除外する行・除外するユーザー', () => {
    assert.strictEqual(decide(msg('viewer', 'https://example.com'), ctx()).reason, 'ignore_line');
    assert.strictEqual(decide(msg('viewer', 'hi', { chatter_user_login: 'NightBot' }), ctx()).reason, 'ignore_user');
});

test('エモート: Twitch のエモートは断片の種類で、BTTV/FFZ は一覧で取り除く。何も残らなければ無視', () => {
    const event = msg('viewer', 'Kappa hello LUL', {
        message: { text: 'Kappa hello LUL', fragments: [{ type: 'emote', text: 'Kappa' }, { type: 'text', text: ' hello LUL' }] }
    });

    assert.strictEqual(removeEmotes(event, ['LUL']), 'hello');
    assert.strictEqual(decide(event, ctx()).text, 'hello');
    assert.strictEqual(decide(msg('viewer', 'LUL monkaS'), ctx()).reason, 'only_emotes');
});

test('翻訳の方向: 日本語を含めば英語へ、含まなければ日本語へ', () => {
    assert.strictEqual(decide(msg('viewer', 'こんにちは'), ctx()).toLang, 'en');
    assert.strictEqual(decide(msg('viewer', 'hello'), ctx()).toLang, 'ja');
});

test('クールダウンは IRC 版と同じ数え方（1 分以内に設定値に達した発言から止める）。モデレーターは対象外', () => {
    let now = 0;
    const cooldown = new Cooldown(() => now);
    const c = ctx({ cooldown, coolDownCount: 3 });
    const results = [];

    for (let i = 0; i < 4; i++) { results.push(decide(msg('viewer', 'hi', { chatter_user_login: 'spammer' }), c).action); }
    assert.deepStrictEqual(results, ['translate', 'translate', 'ignore', 'ignore']);

    now += 61e3;
    assert.strictEqual(decide(msg('viewer', 'hi', { chatter_user_login: 'spammer' }), c).action, 'translate');

    for (let i = 0; i < 10; i++) { assert.strictEqual(decide(msg('mod', 'hi'), c).action, 'translate'); }
});
