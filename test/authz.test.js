'use strict';

/**
 * 権限の分離（仕様書 12 節「いちばん重要なので、全 API を対象にテストする」）。
 *
 * - 配信者は他人のチャンネルのどの API にも触れない（存在しないチャンネルと同じ 403）
 * - 運営者は配信者の代わりに操作できない（D18）: 設定・リスト・秘密の値・使用量
 * - 配信者は運営者の API に触れない
 * 拒否されたリクエストでは、ファイルも管理プロセスへの依頼も変わらないことを確かめる。
 */

const test = require('node:test');
const assert = require('node:assert');
const h = require('./webHarness');

// 対象チャンネルを :login に入れた API の一覧
const OWNER_ONLY = [
    ['GET', '/api/channels/:login/config'],
    ['PUT', '/api/channels/:login/config', { values: { coolDownCount: 9 } }],
    ['GET', '/api/channels/:login/lists'],
    ['PUT', '/api/channels/:login/lists/ignoreusers', { items: ['intruder'] }],
    ['POST', '/api/channels/:login/emotes/refresh', {}],
    ['GET', '/api/channels/:login/google-key'],
    ['POST', '/api/channels/:login/google-key', { content: JSON.stringify(h.VALID_KEY) }],
    ['DELETE', '/api/channels/:login/google-key', {}],
    ['GET', '/api/channels/:login/bot'],
    ['DELETE', '/api/channels/:login/bot', {}],
    ['GET', '/api/channels/:login/usage']
];

const OPERATOR_OR_OWNER = [
    ['GET', '/api/channels/:login'],
    ['POST', '/api/channels/:login/start', {}],
    ['POST', '/api/channels/:login/stop', {}],
    ['POST', '/api/channels/:login/restart', {}],
    ['GET', '/api/channels/:login/logs'],
    ['GET', '/api/channels/:login/logs/bot'],
    ['GET', '/api/channels/:login/audit']
];

const OPERATOR_ONLY = [
    ['GET', '/api/channels'],
    ['POST', '/api/channels', { login: 'newcomer' }],
    ['DELETE', '/api/channels/bob', { confirm: 'bob' }],
    ['GET', '/api/system/logs'],
    ['GET', '/api/system/logs/manager'],
    ['GET', '/api/audit'],
    ['GET', '/api/shared/config'],
    ['PUT', '/api/shared/config', { values: { twitchClientId: 'hijackedclient1' } }],
    ['GET', '/api/shared/operators'],
    ['PUT', '/api/shared/operators', { operators: ['alice'] }]
];

let alice;
let operator;

test.before(async () => {
    await h.start();

    for (const login of ['alice', 'bob']) { h.registerChannel(login); }

    alice = await h.loginAs('alice');
    operator = await h.loginAs('op_admin');

    // bob のチャンネルを、bot 接続・キー・リスト入りの状態にしておく
    const bob = await h.loginAs('bob');

    await h.connectBot(bob, 'bob', 'bob_bot');
    await h.request(bob, 'POST', '/api/channels/bob/google-key', { body: { content: JSON.stringify(h.VALID_KEY) } });
    await h.request(bob, 'PUT', '/api/channels/bob/lists/ignoreusers', { body: { items: ['nightbot'] } });
});

test.after(() => h.stop());

function fill(url, login) {
    return url.replace(':login', login);
}

async function expectAllForbidden(jar, endpoints, login, label) {
    const before = h.snapshotDir(h.paths.channel('bob').root);
    const requestsBefore = h.manager.requests.length;
    const revokedBefore = h.twitch.revoked.length;
    const operatorsBefore = h.snapshotDir(h.paths.CONFIG_DIR);

    for (const [method, url, body] of endpoints) {
        const target = fill(url, login);
        const res = await h.request(jar, method, target, { body });

        assert.strictEqual(res.status, 403, label + ': ' + method + ' ' + target + ' が拒否されませんでした（' + res.status + '）');
        // 秘密の値が拒否の応答に混ざらない
        assert.ok(res.text.indexOf('SECRETKEYMATERIAL') === -1 && res.text.indexOf('access-bob') === -1);
    }

    assert.deepStrictEqual(h.snapshotDir(h.paths.channel('bob').root), before, label + ': bob のファイルが変わりました');
    assert.deepStrictEqual(h.snapshotDir(h.paths.CONFIG_DIR), operatorsBefore, label + ': 共通の設定が変わりました');
    assert.strictEqual(h.manager.requests.length, requestsBefore, label + ': 管理プロセスに依頼が送られました');
    assert.strictEqual(h.twitch.revoked.length, revokedBefore, label + ': トークンが無効化されました');
}

test('配信者は他人のチャンネルのどの API も使えない', async () => {
    await expectAllForbidden(alice, OWNER_ONLY.concat(OPERATOR_OR_OWNER), 'bob', 'alice → bob');
});

test('配信者は他人のチャンネルの bot アカウント接続を始められない', async () => {
    const res = await h.request(alice, 'GET', '/auth/bot/bob');

    assert.strictEqual(res.status, 403);
});

test('存在しないチャンネル・不正なログイン名も同じ 403 になる（他人のチャンネルの有無を探らせない）', async () => {
    const other = await h.request(alice, 'GET', '/api/channels/bob');
    const missing = await h.request(alice, 'GET', '/api/channels/nobody_here');
    const invalid = await h.request(alice, 'GET', '/api/channels/..%2F..%2Fconfig');

    assert.strictEqual(missing.status, 403);
    assert.strictEqual(invalid.status, 403);
    assert.deepStrictEqual(missing.body, other.body);
});

test('配信者は運営者の API を使えない', async () => {
    await expectAllForbidden(alice, OPERATOR_ONLY, 'bob', 'alice → 運営者の API');
    assert.ok(h.channels.exists('bob'));
    assert.strictEqual(h.channels.exists('newcomer'), false);
});

test('運営者は配信者の代わりに設定・リスト・秘密の値・使用量を扱えない（D18）', async () => {
    await expectAllForbidden(operator, OWNER_ONLY, 'bob', '運営者 → bob');

    const res = await h.request(operator, 'GET', '/auth/bot/bob');

    assert.strictEqual(res.status, 403);
});

test('運営者は他人のチャンネルの状態・起動停止・ログ・記録を扱える', async () => {
    for (const [method, url, body] of OPERATOR_OR_OWNER) {
        const res = await h.request(operator, method, fill(url, 'bob'), { body });

        assert.strictEqual(res.status, 200, method + ' ' + url + ': ' + res.text);
    }
});

test('運営者が見るチャンネルの状態には、配信者だけの情報（bot・キー・使用量）が入らない', async () => {
    const res = await h.request(operator, 'GET', '/api/channels/bob');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.owner, undefined);
    assert.ok(res.text.indexOf('bob_bot') === -1);
    assert.ok(res.text.indexOf('alice-project') === -1);
});

test('配信者は自分のチャンネルの API をすべて使える', async () => {
    for (const [method, url, body] of OWNER_ONLY.concat(OPERATOR_OR_OWNER)) {
        const res = await h.request(alice, method, fill(url, 'alice'), { body });

        assert.strictEqual(res.status, 200, method + ' ' + url + ': ' + res.text);
    }
});

test('ログイン名の大文字小文字を変えても他人のチャンネルには届かない', async () => {
    assert.strictEqual((await h.request(alice, 'GET', '/api/channels/BOB/config')).status, 403);
    assert.strictEqual((await h.request(alice, 'GET', '/api/channels/ALICE/config')).status, 200);
});

test('配信者の操作の記録には他のチャンネルの記録が入らない', async () => {
    const res = await h.request(alice, 'GET', '/api/channels/alice/audit');

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.entries.length > 0);
    assert.ok(res.body.entries.every((entry) => entry.channel === 'alice'));
});

test('チャンネルが削除されると、その配信者のセッションはすぐに使えなくなる', async () => {
    const carol = 'carol_ch';

    h.USERS[carol] = { id: '300', login: carol, display_name: 'Carol' };
    h.registerChannel(carol);

    const jar = await h.loginAs(carol);

    assert.strictEqual((await h.request(jar, 'GET', '/api/channels/carol_ch')).status, 200);

    // セッションの破棄とは別に、リクエストごとの権限確認でも弾かれる（ファイルだけ消えた場合）
    h.channels.removeFiles(carol);

    assert.strictEqual((await h.request(jar, 'GET', '/api/channels/carol_ch')).status, 401);
});
