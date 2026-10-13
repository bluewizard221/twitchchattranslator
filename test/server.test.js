'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./webHarness');
const { readJson, writeJson } = require('./helpers');

test.before(async () => {
    await h.start();

    for (const login of ['alice', 'bob']) { h.registerChannel(login); }
});

test.after(() => h.stop());

function auditEntries() {
    const file = h.paths.AUDIT_LOG;

    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
}

function mode(file) {
    return (fs.statSync(file).mode & 0o777).toString(8);
}

// ------------------------------------------------------------------
// ログイン
// ------------------------------------------------------------------

test('未ログインでは API が 401、画面はログインへリダイレクトされる', async () => {
    const jar = h.newJar();

    assert.strictEqual((await h.request(jar, 'GET', '/api/session')).status, 401);
    assert.strictEqual((await h.request(jar, 'GET', '/api/channels/alice')).status, 401);

    const page = await h.request(jar, 'GET', '/');

    assert.strictEqual(page.status, 302);
    assert.strictEqual(page.headers.get('location'), '/login');
});

test('ログインページと静的ファイルは認証なしで見られる', async () => {
    const jar = h.newJar();

    assert.strictEqual((await h.request(jar, 'GET', '/login')).status, 200);
    assert.strictEqual((await h.request(jar, 'GET', '/css/style.css')).status, 200);
    assert.strictEqual((await h.request(jar, 'GET', '/js/app.js')).status, 200);
});

test('ログインでは channel:bot の許可を求め、戻り先は設定どおり', async () => {
    const jar = h.newJar();
    const start = await h.request(jar, 'GET', '/auth/twitch');
    const url = new URL(start.headers.get('location'));

    assert.strictEqual(url.origin + url.pathname, 'https://id.twitch.tv/oauth2/authorize');
    assert.strictEqual(url.searchParams.get('client_id'), 'testclientid01');
    assert.strictEqual(url.searchParams.get('scope'), 'channel:bot');
    assert.strictEqual(url.searchParams.get('redirect_uri'), 'http://localhost:3000/auth/twitch/callback');
});

test('OAuth の state が一致しないと拒否される', async () => {
    const jar = h.newJar();

    await h.request(jar, 'GET', '/auth/twitch');

    const callback = await h.request(jar, 'GET', '/auth/twitch/callback?code=alice&state=wrong-state');

    assert.strictEqual(callback.headers.get('location'), '/login?error=state');
    assert.strictEqual((await h.request(jar, 'GET', '/api/session')).status, 401);
});

test('運営者でも登録済みの配信者でもないユーザーはログインできず、トークンは無効化される', async () => {
    const jar = h.newJar();
    const { callback } = await h.oauth(jar, '/auth/twitch', 'viewer');

    assert.strictEqual(callback.headers.get('location'), '/login?error=denied&login=viewer');
    assert.strictEqual((await h.request(jar, 'GET', '/api/session')).status, 401);
    assert.ok(h.twitch.revoked.some((token) => token.startsWith('access-viewer-')));
});

test('配信者がログインすると、配信者の ID と channel:bot の許可が記録され、管理プロセスに通知される', async () => {
    const before = h.manager.requests.length;
    const jar = await h.loginAs('alice');
    const local = readJson(h.paths.channel('alice').localConfig);
    const meta = h.channels.get('alice');

    assert.deepStrictEqual(jar.session.role, { login: 'alice', isOperator: false, channel: 'alice' });
    assert.strictEqual(local.config.twitchBroadcasterId, '100');
    assert.strictEqual(local.config.twitchChannel, 'alice');
    assert.ok(meta.channelBotGrantedAt);
    assert.ok(h.manager.requests.slice(before).some((r) => r.action === 'channels.changed'));

    const login = auditEntries().filter((e) => e.action === 'login' && e.actor === 'alice').pop();

    assert.strictEqual(login.channel, 'alice');
});

test('2 回目以降のログインでは、ID が変わらなければ管理プロセスに通知しない', async () => {
    await h.loginAs('alice');

    const before = h.manager.requests.length;

    await h.loginAs('alice');

    assert.strictEqual(h.manager.requests.slice(before).filter((r) => r.action === 'channels.changed').length, 0);
});

test('channel:bot を許可しなかった場合は記録しない', async () => {
    h.registerChannel('dave_ch');
    h.USERS.dave_ch = { id: '400', login: 'dave_ch', display_name: 'Dave' };

    await h.loginAs('dave_ch', []);

    assert.strictEqual(h.channels.get('dave_ch').channelBotGrantedAt, undefined);
});

test('運営者はチャンネルがなくてもログインでき、セッションに運営者の役割が入る', async () => {
    const jar = await h.loginAs('op_admin');

    assert.deepStrictEqual(jar.session.role, { login: 'op_admin', isOperator: true, channel: null });
    assert.strictEqual(h.channels.exists('op_admin'), false);
});

test('ログイン時のトークンはセッションに保存しない', async () => {
    const jar = await h.loginAs('alice');
    const all = Array.from(h.app.locals.sessionStore.sessions.values()).map((entry) => entry.data).join('\n');

    assert.ok(jar.session.user);
    assert.ok(all.indexOf('"alice"') !== -1, 'セッションの中身を確認できていない');
    assert.ok(all.indexOf('access-alice') === -1);
    assert.ok(all.indexOf('refresh-alice') === -1);
});

test('CSRF トークンなしの更新は 403 になる', async () => {
    const jar = await h.loginAs('alice');
    const result = await h.request(jar, 'PUT', '/api/channels/alice/config', { body: { values: { coolDownCount: 3 } }, csrf: false });

    assert.strictEqual(result.status, 403);
    assert.strictEqual(result.body.code, 'csrf');
});

test('ログアウトするとセッションが無効になる', async () => {
    const jar = await h.loginAs('alice');
    const result = await h.request(jar, 'POST', '/auth/logout', { body: {} });

    assert.strictEqual(result.status, 200);
    assert.strictEqual((await h.request(jar, 'GET', '/api/session')).status, 401);
});

test('セキュリティ関連のヘッダーが付与される', async () => {
    const page = await h.request(h.newJar(), 'GET', '/login');

    assert.ok(page.headers.get('content-security-policy').indexOf("default-src 'self'") !== -1);
    assert.strictEqual(page.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(page.headers.get('x-powered-by'), null);
});

// ------------------------------------------------------------------
// bot アカウントの接続
// ------------------------------------------------------------------

test('bot アカウントの接続では必要な許可を求め、アカウントの選び直しを強制する', async () => {
    const jar = await h.loginAs('alice');
    const start = await h.request(jar, 'GET', '/auth/bot/alice');
    const url = new URL(start.headers.get('location'));

    assert.strictEqual(url.searchParams.get('scope'), h.BOT_SCOPES.join(' '));
    assert.strictEqual(url.searchParams.get('force_verify'), 'true');
});

test('bot アカウントを接続すると、トークンが 600 で保存され、API には返らない', async () => {
    const jar = await h.loginAs('alice');
    const { callback } = await h.connectBot(jar, 'alice', 'alice_bot');

    assert.strictEqual(callback.headers.get('location'), '/#channel');

    // 接続しても配信者のログインは保たれる
    const session = await h.request(jar, 'GET', '/api/session');

    assert.strictEqual(session.body.user.login, 'alice');
    assert.strictEqual(session.body.flash.type, 'ok');
    assert.strictEqual((await h.request(jar, 'GET', '/api/session')).body.flash, null);

    const file = h.paths.channel('alice').botTokens;
    const saved = readJson(file);

    assert.strictEqual(mode(file), '600');
    assert.strictEqual(saved.userId, '101');
    assert.strictEqual(saved.login, 'alice_bot');
    assert.ok(saved.accessToken.startsWith('access-alice_bot-'));

    const status = await h.request(jar, 'GET', '/api/channels/alice/bot');
    const detail = await h.request(jar, 'GET', '/api/channels/alice');

    assert.strictEqual(status.body.status.connected, true);
    assert.strictEqual(status.body.status.botLogin, 'alice_bot');
    assert.deepStrictEqual(status.body.status.missingScopes, []);
    assert.strictEqual(detail.body.owner.bot.botLogin, 'alice_bot');

    for (const text of [status.text, detail.text]) {
        assert.ok(text.indexOf(saved.accessToken) === -1 && text.indexOf(saved.refreshToken) === -1);
    }

    const entry = auditEntries().filter((e) => e.action === 'bot.connect').pop();

    assert.strictEqual(entry.channel, 'alice');
    assert.deepStrictEqual(entry.detail, { botLogin: 'alice_bot' });
    assert.ok(JSON.stringify(auditEntries()).indexOf('access-') === -1);
});

test('許可が足りない bot アカウントは接続せず、トークンを無効化する', async () => {
    const jar = await h.loginAs('bob');
    const { callback } = await h.connectBot(jar, 'bob', 'bob_bot', ['user:read:chat', 'user:bot']);

    assert.strictEqual(callback.headers.get('location'), '/#channel');
    assert.strictEqual(fs.existsSync(h.paths.channel('bob').botTokens), false);
    assert.ok(h.twitch.revoked.some((t) => t.startsWith('access-bob_bot-')));

    const flash = (await h.request(jar, 'GET', '/api/session')).body.flash;

    assert.strictEqual(flash.type, 'error');
    assert.ok(flash.text.indexOf('user:write:chat') !== -1);
});

test('チャンネル主のアカウントを bot アカウントにはできない', async () => {
    const jar = await h.loginAs('bob');
    const { callback } = await h.connectBot(jar, 'bob', 'bob');

    assert.strictEqual(callback.headers.get('location'), '/#channel');
    assert.strictEqual(fs.existsSync(h.paths.channel('bob').botTokens), false);
    assert.ok((await h.request(jar, 'GET', '/api/session')).body.flash.text.indexOf('チャンネル主') !== -1);
});

test('接続を始めたあとで権限を失った場合は保存せず、トークンを無効化する', async () => {
    h.registerChannel('erin_ch');
    h.USERS.erin_ch = { id: '500', login: 'erin_ch', display_name: 'Erin' };

    const jar = await h.loginAs('erin_ch');
    const start = await h.request(jar, 'GET', '/auth/bot/erin_ch');
    const state = new URL(start.headers.get('location')).searchParams.get('state');

    h.channels.removeFiles('erin_ch');

    const callback = await h.request(jar, 'GET', '/auth/twitch/callback?code=' + encodeURIComponent('bob_bot:' + h.BOT_SCOPES.join(',')) + '&state=' + state);

    assert.strictEqual(callback.headers.get('location'), '/login');
    assert.strictEqual(fs.existsSync(h.paths.channel('erin_ch').root), false);
    assert.ok(h.twitch.revoked.length > 0 && h.twitch.revoked[h.twitch.revoked.length - 1].startsWith('access-bob_bot-'));
});

test('bot アカウントの接続を解除すると、両方のトークンを無効化してファイルを消す', async () => {
    const jar = await h.loginAs('bob');

    await h.connectBot(jar, 'bob', 'bob_bot');

    const tokens = readJson(h.paths.channel('bob').botTokens);
    const result = await h.request(jar, 'DELETE', '/api/channels/bob/bot', { body: {} });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.removed, true);
    assert.strictEqual(result.body.revoked, true);
    assert.ok(h.twitch.revoked.indexOf(tokens.accessToken) !== -1);
    assert.ok(h.twitch.revoked.indexOf(tokens.refreshToken) !== -1);
    assert.strictEqual(fs.existsSync(h.paths.channel('bob').botTokens), false);
    assert.strictEqual(auditEntries().pop().action, 'bot.disconnect');
});

// ------------------------------------------------------------------
// チャンネルの設定・リスト
// ------------------------------------------------------------------

test('チャンネルの設定を保存でき、対象チャンネルと配信者の ID は変えられない', async () => {
    const jar = await h.loginAs('alice');
    const ng = await h.request(jar, 'PUT', '/api/channels/alice/config', { body: { values: { twitchChannel: 'bob', twitchBroadcasterId: '200' } } });

    assert.strictEqual(ng.status, 400);
    assert.ok(ng.body.fieldErrors.twitchChannel);
    assert.ok(ng.body.fieldErrors.twitchBroadcasterId);

    const ok = await h.request(jar, 'PUT', '/api/channels/alice/config', { body: { values: { coolDownCount: 7, dailyCharLimit: 50000 } } });

    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.body.saved.sort(), ['coolDownCount', 'dailyCharLimit']);

    const local = readJson(h.paths.channel('alice').localConfig);

    assert.strictEqual(local.config.coolDownCount, 7);
    assert.strictEqual(local.config.twitchChannel, 'alice');
    assert.strictEqual(local.config.twitchBroadcasterId, '100');
    assert.strictEqual(mode(h.paths.channel('alice').localConfig), '600');
});

test('設定を変えたとき、bot が動いていれば再起動して反映する', async () => {
    const jar = await h.loginAs('alice');

    h.manager.running.add('alice');

    try {
        const before = h.manager.requests.length;
        const res = await h.request(jar, 'PUT', '/api/channels/alice/config', { body: { values: { coolDownCount: 4 } } });

        assert.strictEqual(res.body.restarted, true);
        assert.ok(h.manager.requests.slice(before).some((r) => r.action === 'channel.restart' && r.payload.login === 'alice'));
    } finally {
        h.manager.running.delete('alice');
    }

    const stopped = await h.request(jar, 'PUT', '/api/channels/alice/config', { body: { values: { coolDownCount: 5 } } });

    assert.strictEqual(stopped.body.restarted, false);
});

test('リストを保存すると、そのチャンネルのファイルに書き、bot に読み直させる', async () => {
    const jar = await h.loginAs('alice');
    const before = h.manager.requests.length;
    const res = await h.request(jar, 'PUT', '/api/channels/alice/lists/ignoreusers', { body: { items: ['nightbot', 'nightbot', 'streamelements'] } });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.items, ['nightbot', 'streamelements']);
    assert.deepStrictEqual(readJson(h.paths.channel('alice').ignoreUsers).ignoreusers, ['nightbot', 'streamelements']);
    assert.deepStrictEqual(h.manager.requests.slice(before).map((r) => r.action), ['channel.reload']);

    const list = await h.request(jar, 'GET', '/api/channels/alice/lists');

    assert.deepStrictEqual(list.body.ignoreusers.items, ['nightbot', 'streamelements']);
    assert.ok(list.text.indexOf(h.ROOT) === -1, '絶対パスを返さない');
});

test('未知のリスト ID は 404、不正な値は 400', async () => {
    const jar = await h.loginAs('alice');

    assert.strictEqual((await h.request(jar, 'PUT', '/api/channels/alice/lists/unknown', { body: { items: [] } })).status, 404);
    assert.strictEqual((await h.request(jar, 'PUT', '/api/channels/alice/lists/ignoreline', { body: { items: ['('] } })).status, 400);
});

test('エモートの取得は管理プロセスに依頼する（対象はパスのチャンネル）', async () => {
    const jar = await h.loginAs('alice');
    const before = h.manager.requests.length;
    const res = await h.request(jar, 'POST', '/api/channels/alice/emotes/refresh', { body: { channel: 'bob' } });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.count, 3);
    assert.deepStrictEqual(h.manager.requests.slice(before), [{ action: 'emotes.refresh', payload: { login: 'alice' } }]);
});

// ------------------------------------------------------------------
// Google Cloud のキー
// ------------------------------------------------------------------

test('Google Cloud のキーはチャンネルの決まった場所に 600 で保存し、秘密鍵は返さず記録もしない', async () => {
    const jar = await h.loginAs('alice');
    const res = await h.request(jar, 'POST', '/api/channels/alice/google-key', { body: { content: JSON.stringify(h.VALID_KEY), fileName: '../../evil.json' } });
    const file = h.paths.channel('alice').googleKey;

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.projectId, 'alice-project');
    assert.strictEqual(mode(file), '600');
    assert.strictEqual(readJson(file).private_key, h.VALID_KEY.private_key);
    assert.ok(res.text.indexOf('SECRETKEYMATERIAL') === -1);
    assert.ok(fs.readFileSync(h.paths.AUDIT_LOG, 'utf8').indexOf('SECRETKEYMATERIAL') === -1);
    assert.strictEqual(fs.existsSync(path.join(h.ROOT, 'evil.json')), false);

    const status = await h.request(jar, 'GET', '/api/channels/alice/google-key');

    assert.strictEqual(status.body.status.valid, true);
    assert.ok(status.text.indexOf('SECRETKEYMATERIAL') === -1);
});

test('サービスアカウントキーでないファイルは拒否する', async () => {
    const jar = await h.loginAs('bob');
    const res = await h.request(jar, 'POST', '/api/channels/bob/google-key', { body: { content: JSON.stringify({ type: 'authorized_user' }) } });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(fs.existsSync(h.paths.channel('bob').googleKey), false);
});

test('Google Cloud のキーを削除すると、GCP 側での削除を案内する', async () => {
    const jar = await h.loginAs('bob');

    await h.request(jar, 'POST', '/api/channels/bob/google-key', { body: { content: JSON.stringify(h.VALID_KEY) } });

    const res = await h.request(jar, 'DELETE', '/api/channels/bob/google-key', { body: {} });

    assert.strictEqual(res.body.removed, true);
    assert.ok(res.body.notice.indexOf('GCP') !== -1);
    assert.strictEqual(fs.existsSync(h.paths.channel('bob').googleKey), false);
});

// ------------------------------------------------------------------
// 状態・使用量・起動停止
// ------------------------------------------------------------------

test('配信者は自分のチャンネルの準備状況と使用量を見られる', async () => {
    writeJson(path.join(h.paths.USAGE_DIR, 'alice.json'), {
        days: { [new Date().toLocaleDateString('sv-SE')]: 1200 },
        months: { [new Date().toLocaleDateString('sv-SE').slice(0, 7)]: 34000 }
    });

    const jar = await h.loginAs('alice');
    const res = await h.request(jar, 'GET', '/api/channels/alice');
    const usage = await h.request(jar, 'GET', '/api/channels/alice/usage');

    assert.strictEqual(res.body.login, 'alice');
    assert.strictEqual(typeof res.body.ready, 'boolean');
    assert.ok(Array.isArray(res.body.missing));
    assert.strictEqual(res.body.owner.broadcasterId, '100');
    assert.strictEqual(usage.body.today, 1200);
    assert.strictEqual(usage.body.month, 34000);
});

test('起動・停止は管理プロセスに依頼し、記録を残す', async () => {
    const jar = await h.loginAs('alice');
    const res = await h.request(jar, 'POST', '/api/channels/alice/stop', { body: {} });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(h.manager.requests.pop(), { action: 'channel.stop', payload: { login: 'alice' } });
    assert.strictEqual(auditEntries().pop().action, 'channel.stop');
});

test('管理プロセスに接続できないときは 503 を返す', async () => {
    const jar = await h.loginAs('alice');

    h.manager.connected = false;

    try {
        const res = await h.request(jar, 'POST', '/api/channels/alice/start', { body: {} });

        assert.strictEqual(res.status, 503);
        assert.strictEqual((await h.request(jar, 'GET', '/api/session')).body.managerAvailable, false);
    } finally {
        h.manager.connected = true;
    }
});

// ------------------------------------------------------------------
// ログ
// ------------------------------------------------------------------

test('チャンネルのログはそのチャンネルのファイルだけを読み、トークンらしき文字列は伏せる', async () => {
    const file = path.join(h.paths.channel('alice').logDir, 'twitchchattranslator.log');

    fs.writeFileSync(file, '[INFO] hello\n[ERROR] Bearer abcdefghijk failed\n');
    fs.mkdirSync(h.paths.LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(h.paths.LOG_DIR, 'manager.log'), '[INFO] manager line\n');

    const jar = await h.loginAs('alice');
    const res = await h.request(jar, 'GET', '/api/channels/alice/logs/bot?level=warn');

    assert.deepStrictEqual(res.body.lines, ['[ERROR] Bearer *** failed']);
    assert.strictEqual(res.body.path, 'channels/alice/logs/twitchchattranslator.log');
    assert.strictEqual((await h.request(jar, 'GET', '/api/channels/alice/logs/manager')).status, 404);

    const op = await h.loginAs('op_admin');
    const sys = await h.request(op, 'GET', '/api/system/logs/manager');

    assert.deepStrictEqual(sys.body.lines, ['[INFO] manager line']);
    assert.strictEqual((await h.request(op, 'GET', '/api/system/logs/bot')).status, 404);
});

// ------------------------------------------------------------------
// 運営者: チャンネルの登録・削除
// ------------------------------------------------------------------

test('運営者はチャンネルを登録でき、形式の誤りと重複は拒否される', async () => {
    const op = await h.loginAs('op_admin');

    assert.strictEqual((await h.request(op, 'POST', '/api/channels', { body: { login: 'a' } })).status, 400);
    assert.strictEqual((await h.request(op, 'POST', '/api/channels', { body: { login: '../etc' } })).status, 400);
    assert.strictEqual((await h.request(op, 'POST', '/api/channels', { body: { login: 'alice' } })).status, 400);

    const before = h.manager.requests.length;
    const res = await h.request(op, 'POST', '/api/channels', { body: { login: 'Frank_Ch' } });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.channel.login, 'frank_ch');
    assert.strictEqual(h.channels.get('frank_ch').createdBy, 'op_admin');
    assert.ok(h.manager.requests.slice(before).some((r) => r.action === 'channels.changed'));
    assert.strictEqual(auditEntries().pop().action, 'channel.register');

    const list = await h.request(op, 'GET', '/api/channels');

    assert.ok(list.body.channels.some((c) => c.login === 'frank_ch'));
    assert.ok(list.text.indexOf('access-') === -1);
});

test('チャンネルの削除はログイン名の再入力が必要', async () => {
    const op = await h.loginAs('op_admin');
    const res = await h.request(op, 'DELETE', '/api/channels/frank_ch', { body: { confirm: 'alice' } });

    assert.strictEqual(res.status, 400);
    assert.ok(h.channels.exists('frank_ch'));
});

test('チャンネルを削除すると、bot を止め、トークンを無効化し、キーとファイルとセッションを消す（D11）', async () => {
    const login = 'gina_ch';

    h.USERS[login] = { id: '700', login, display_name: 'Gina' };
    h.USERS.gina_bot = { id: '701', login: 'gina_bot', display_name: 'GinaBot' };
    h.registerChannel(login);

    const gina = await h.loginAs(login);

    await h.connectBot(gina, login, 'gina_bot');
    await h.request(gina, 'POST', '/api/channels/' + login + '/google-key', { body: { content: JSON.stringify(h.VALID_KEY) } });
    writeJson(path.join(h.paths.USAGE_DIR, login + '.json'), { days: {}, months: {} });

    const tokens = readJson(h.paths.channel(login).botTokens);
    const op = await h.loginAs('op_admin');
    const before = h.manager.requests.length;
    const res = await h.request(op, 'DELETE', '/api/channels/' + login, { body: { confirm: 'GINA_CH' } });

    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body.steps.map((s) => s.step), ['stop', 'subscriptions', 'revoke', 'files', 'sessions', 'audit']);
    assert.ok(res.body.steps.every((s) => s.ok), JSON.stringify(res.body.steps));

    // 1. 停止 → 2. 購読の削除の順に依頼する
    const actions = h.manager.requests.slice(before).map((r) => r.action);

    assert.ok(actions.indexOf('channel.stop') < actions.indexOf('eventsub.sync'));

    // 3. トークンの無効化
    assert.ok(h.twitch.revoked.indexOf(tokens.accessToken) !== -1);
    assert.ok(h.twitch.revoked.indexOf(tokens.refreshToken) !== -1);

    // 4. キー・トークン・設定・使用量
    assert.strictEqual(fs.existsSync(h.paths.channel(login).root), false);
    assert.strictEqual(fs.existsSync(path.join(h.paths.USAGE_DIR, login + '.json')), false);

    // 5. セッション（保存先から消す。リクエストごとの権限確認とは別に効いていること）
    assert.match(res.body.steps.find((s) => s.step === 'sessions').detail, /^[1-9]\d* 件/);
    assert.ok(Array.from(h.app.locals.sessionStore.sessions.values()).every((entry) => entry.login !== login));
    assert.strictEqual((await h.request(gina, 'GET', '/api/session')).status, 401);

    // 6. 記録（秘密の値は書かない）
    const entry = auditEntries().pop();

    assert.strictEqual(entry.action, 'channel.delete');
    assert.strictEqual(entry.channel, login);
    assert.ok(JSON.stringify(entry).indexOf('access-') === -1);
    assert.ok(res.body.notices.some((n) => n.indexOf('GCP') !== -1));
});

test('管理プロセスに接続できなくても、トークンの無効化とファイルの削除は行う', async () => {
    const login = 'hank_ch';

    h.USERS[login] = { id: '800', login, display_name: 'Hank' };
    h.registerChannel(login);

    const hank = await h.loginAs(login);

    await h.connectBot(hank, login, 'bob_bot');

    const tokens = readJson(h.paths.channel(login).botTokens);
    const op = await h.loginAs('op_admin');

    h.manager.connected = false;

    try {
        const res = await h.request(op, 'DELETE', '/api/channels/' + login, { body: { confirm: login } });
        const byStep = Object.fromEntries(res.body.steps.map((s) => [s.step, s.ok]));

        assert.strictEqual(byStep.stop, false);
        assert.strictEqual(byStep.subscriptions, false);
        assert.strictEqual(byStep.revoke, true);
        assert.strictEqual(byStep.files, true);
        assert.ok(h.twitch.revoked.indexOf(tokens.accessToken) !== -1);
        assert.strictEqual(fs.existsSync(h.paths.channel(login).root), false);
    } finally {
        h.manager.connected = true;
    }
});

test('存在しないチャンネルの削除は 404', async () => {
    const op = await h.loginAs('op_admin');

    assert.strictEqual((await h.request(op, 'DELETE', '/api/channels/nobody_here', { body: { confirm: 'nobody_here' } })).status, 404);
});

// ------------------------------------------------------------------
// 運営者: 共通の設定・運営者の一覧・記録
// ------------------------------------------------------------------

test('共通の設定の秘密の値は返さず、保存は config/local.json に入る', async () => {
    const op = await h.loginAs('op_admin');
    const before = await h.request(op, 'GET', '/api/shared/config');

    assert.strictEqual(before.body.values.twitchClientId.value, 'testclientid01');
    assert.strictEqual(before.body.values.twitchClientSecret.value, null);
    assert.strictEqual(before.body.values.twitchClientSecret.hasValue, true);
    assert.ok(before.text.indexOf('test-client-secret') === -1);

    const bad = await h.request(op, 'PUT', '/api/shared/config', { body: { values: { eventsubCallbackUrl: 'http://example.com/x', eventsubSecret: 'short' } } });

    assert.strictEqual(bad.status, 400);
    assert.ok(bad.body.fieldErrors.eventsubCallbackUrl);
    assert.ok(bad.body.fieldErrors.eventsubSecret);

    const secret = 'abcdefghij0123456789';
    const ok = await h.request(op, 'PUT', '/api/shared/config', {
        body: { values: { eventsubCallbackUrl: 'https://translate.example.com/eventsub/callback', eventsubSecret: secret, twitchClientSecret: '' } }
    });

    assert.strictEqual(ok.status, 200, ok.text);
    assert.ok(ok.text.indexOf(secret) === -1);

    const local = readJson(h.paths.LOCAL_CONFIG);

    assert.strictEqual(local.config.eventsub.secret, secret);
    assert.strictEqual(local.config.eventsub.callbackUrl, 'https://translate.example.com/eventsub/callback');
    assert.strictEqual(local.config.twitchClientSecret, undefined, '空欄の秘密の値は変更しない');
    assert.strictEqual(mode(h.paths.LOCAL_CONFIG), '600');
    assert.ok(fs.readFileSync(h.paths.AUDIT_LOG, 'utf8').indexOf(secret) === -1);
});

test('運営者の一覧を変更でき、自分自身は外せない', async () => {
    const op = await h.loginAs('op_admin');
    const self = await h.request(op, 'PUT', '/api/shared/operators', { body: { operators: ['alice'] } });

    // 環境変数の運営者（op_admin）は画面からは外れないので、自分を外したことにはならない
    assert.strictEqual(self.status, 200);
    assert.deepStrictEqual(self.body.fromFile, ['alice']);
    assert.deepStrictEqual(self.body.fromEnv, ['op_admin']);

    const alice = await h.loginAs('alice');

    assert.strictEqual(alice.session.role.isOperator, true);

    // 自分（ファイルにしかいない運営者）を外す変更は拒否する
    const lockout = await h.request(alice, 'PUT', '/api/shared/operators', { body: { operators: [] } });

    assert.strictEqual(lockout.status, 400);
    assert.strictEqual((await h.request(alice, 'PUT', '/api/shared/operators', { body: { operators: ['bad name!'] } })).status, 400);

    await h.request(op, 'PUT', '/api/shared/operators', { body: { operators: [] } });

    // 権限はリクエストごとに確認するので、外された運営者はすぐに運営者の API を使えなくなる
    assert.strictEqual((await h.request(alice, 'GET', '/api/channels')).status, 403);
});

test('運営者は全体の操作の記録を、新しい順に見られる', async () => {
    const op = await h.loginAs('op_admin');
    const res = await h.request(op, 'GET', '/api/audit?limit=5');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.entries.length, 5);
    assert.ok(res.body.entries[0].at >= res.body.entries[4].at);
});

// ------------------------------------------------------------------
// 回数制限とセッション
// ------------------------------------------------------------------

test('/auth への回数制限が効く', async () => {
    const limited = h.createApp(Object.assign({}, h.config, { rateLimitAuthPerMinute: 3 }), h.logger, { manager: h.manager });
    const srv = await new Promise((resolve) => { const s2 = limited.listen(0, '127.0.0.1', () => resolve(s2)); });

    try {
        const url = 'http://127.0.0.1:' + srv.address().port + '/auth/status';
        const statuses = [];

        for (let i = 0; i < 5; i++) {
            statuses.push((await h.realFetch(url)).status);
        }

        assert.deepStrictEqual(statuses, [200, 200, 200, 429, 429]);
    } finally {
        srv.close();
    }
});

test('未ログインで OAuth を始めただけのセッションは、上限付きの保存先に入る', async () => {
    const store = h.app.locals.sessionStore;
    const before = await new Promise((resolve) => store.length((err, n) => resolve(n)));

    await h.request(h.newJar(), 'GET', '/auth/twitch');

    const after = await new Promise((resolve) => store.length((err, n) => resolve(n)));

    assert.strictEqual(after, before + 1);
    assert.strictEqual(store.maxSessions, 1000);
});
