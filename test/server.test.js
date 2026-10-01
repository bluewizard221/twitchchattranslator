'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { useTempRoot, writeJson, readJson } = require('./helpers');

const ROOT = useTempRoot();

writeJson(path.join(ROOT, 'config', 'default.json'), {
    config: {
        pidFile: 'tmp/test.pid',
        twitchUserName: 'template_bot',
        coolDownCount: 5
    }
});

process.env.WEBUI_TWITCH_CLIENT_ID = 'test-client-id';
process.env.WEBUI_TWITCH_CLIENT_SECRET = 'test-client-secret';
process.env.WEBUI_ALLOWED_USERS = 'streamer_one';
process.env.WEBUI_SESSION_SECRET = 'test-session-secret';
process.env.WEBUI_REDIRECT_URI = 'http://localhost:3000/auth/twitch/callback';

const webConfig = require('../web/lib/webConfig');
const { createApp } = require('../web/app');

const realFetch = globalThis.fetch.bind(globalThis);

// Twitch への通信だけを差し替える（ローカルサーバーへのリクエストは素通しする）
let twitchUser = { id: '111222', login: 'streamer_one', display_name: 'Streamer One', profile_image_url: 'https://static-cdn.jtvnw.net/a.png' };

// エモート取得元は既定で失敗させ、必要なテストだけ成功させる
let emoteRoutes = {};

globalThis.fetch = async (url, options) => {
    const target = String(url);

    if (target.startsWith('https://api.betterttv.net/') || target.startsWith('https://api.frankerfacez.com/')) {
        for (const prefix of Object.keys(emoteRoutes)) {
            if (target.startsWith(prefix)) { return jsonResponse(emoteRoutes[prefix]); }
        }

        return { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}), text: async () => '' };
    }

    if (target.startsWith('https://id.twitch.tv/oauth2/token')) {
        return jsonResponse({ access_token: 'fake-access-token', refresh_token: 'fake-refresh', expires_in: 14400 });
    }
    if (target.startsWith('https://id.twitch.tv/oauth2/revoke')) {
        return jsonResponse({});
    }
    if (target.startsWith('https://api.twitch.tv/helix/users')) {
        return jsonResponse({ data: [twitchUser] });
    }

    return realFetch(url, options);
};

function jsonResponse(body) {
    const text = JSON.stringify(body);

    return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => text };
}

const logs = [];
const logger = {
    info: (msg) => logs.push(['info', msg]),
    warn: (msg) => logs.push(['warn', msg]),
    error: (msg) => logs.push(['error', msg]),
    debug: () => {}
};

const config = webConfig.load();
const app = createApp(config, logger);

let baseUrl;
let server;

test.before(async () => {
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });

    baseUrl = 'http://127.0.0.1:' + server.address().port;
});

test.after(() => {
    server.close();
});

/** 単純なクッキー入れ */
function newJar() {
    return { cookies: {} };
}

async function request(jar, method, url, options) {
    const opts = options || {};
    const headers = Object.assign({ 'Accept': 'application/json' }, opts.headers);
    const cookie = Object.keys(jar.cookies).map((name) => name + '=' + jar.cookies[name]).join('; ');

    if (cookie) { headers.Cookie = cookie; }

    const init = { method: method, headers: headers, redirect: 'manual' };

    if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
    }

    const res = await realFetch(baseUrl + url, init);

    for (const raw of res.headers.getSetCookie()) {
        const pair = raw.split(';')[0];
        const index = pair.indexOf('=');

        jar.cookies[pair.slice(0, index)] = pair.slice(index + 1);
    }

    const text = await res.text();
    let body = null;

    try {
        body = JSON.parse(text);
    } catch (err) {
        body = text;
    }

    return { status: res.status, headers: res.headers, body: body };
}

/** OAuth の往復をたどってログイン済みのセッションを作る */
async function login(jar) {
    const start = await request(jar, 'GET', '/auth/twitch');

    assert.strictEqual(start.status, 302);

    const authorizeUrl = new URL(start.headers.get('location'));
    const state = authorizeUrl.searchParams.get('state');

    assert.strictEqual(authorizeUrl.origin + authorizeUrl.pathname, 'https://id.twitch.tv/oauth2/authorize');
    assert.strictEqual(authorizeUrl.searchParams.get('client_id'), 'test-client-id');
    assert.strictEqual(authorizeUrl.searchParams.get('scope'), '');

    const callback = await request(jar, 'GET', '/auth/twitch/callback?code=fake-code&state=' + encodeURIComponent(state));

    assert.strictEqual(callback.status, 302);
    assert.strictEqual(callback.headers.get('location'), '/');

    const session = await request(jar, 'GET', '/api/session');

    assert.strictEqual(session.status, 200);

    return session.body;
}

// ------------------------------------------------------------------

test('未ログインでは API が 401、画面はログインへリダイレクトされる', async () => {
    const jar = newJar();

    assert.strictEqual((await request(jar, 'GET', '/api/config')).status, 401);

    const page = await request(jar, 'GET', '/');

    assert.strictEqual(page.status, 302);
    assert.strictEqual(page.headers.get('location'), '/login');
});

test('ログインページと静的ファイルは認証なしで見られる', async () => {
    const jar = newJar();

    assert.strictEqual((await request(jar, 'GET', '/login')).status, 200);
    assert.strictEqual((await request(jar, 'GET', '/css/style.css')).status, 200);
    assert.strictEqual((await request(jar, 'GET', '/js/app.js')).status, 200);
});

test('OAuth の state が一致しないと拒否される', async () => {
    const jar = newJar();

    await request(jar, 'GET', '/auth/twitch');

    const callback = await request(jar, 'GET', '/auth/twitch/callback?code=fake-code&state=wrong-state');

    assert.strictEqual(callback.status, 302);
    assert.strictEqual(callback.headers.get('location'), '/login?error=state');
});

test('許可されていないユーザーはログインできない', async () => {
    const jar = newJar();

    twitchUser = { id: '999', login: 'random_viewer', display_name: 'Random', profile_image_url: '' };

    try {
        const start = await request(jar, 'GET', '/auth/twitch');
        const state = new URL(start.headers.get('location')).searchParams.get('state');
        const callback = await request(jar, 'GET', '/auth/twitch/callback?code=fake-code&state=' + state);

        assert.strictEqual(callback.headers.get('location'), '/login?error=denied&login=random_viewer');
        assert.strictEqual((await request(jar, 'GET', '/api/session')).status, 401);
    } finally {
        twitchUser = { id: '111222', login: 'streamer_one', display_name: 'Streamer One', profile_image_url: 'https://static-cdn.jtvnw.net/a.png' };
    }
});

test('ログインすると Twitch のログイン名と ID がセッションに入る', async () => {
    const jar = newJar();
    const session = await login(jar);

    assert.strictEqual(session.user.login, 'streamer_one');
    assert.strictEqual(session.user.id, '111222');
    assert.ok(session.csrfToken);
});

test('CSRF トークンなしの更新は 403 になる', async () => {
    const jar = newJar();

    await login(jar);

    const result = await request(jar, 'PUT', '/api/config', { body: { values: { twitchChannel: 'hacked' } } });

    assert.strictEqual(result.status, 403);
    assert.strictEqual(result.body.code, 'csrf');
});

test('OAuth で得た値をそのまま設定に保存できる', async () => {
    const jar = newJar();
    const session = await login(jar);

    const before = await request(jar, 'GET', '/api/config');

    assert.strictEqual(before.body.oauth.twitchChannel, 'streamer_one');
    assert.strictEqual(before.body.oauth.twitchBroadcasterId, '111222');

    const saved = await request(jar, 'PUT', '/api/config', {
        headers: { 'X-CSRF-Token': session.csrfToken },
        body: {
            values: {
                twitchChannel: before.body.oauth.twitchChannel,
                twitchBroadcasterId: before.body.oauth.twitchBroadcasterId
            }
        }
    });

    assert.strictEqual(saved.status, 200);

    const local = readJson(path.join(ROOT, 'config', 'local.json'));

    assert.strictEqual(local.config.twitchChannel, 'streamer_one');
    assert.strictEqual(local.config.twitchBroadcasterId, '111222');
});

test('secret 項目の値は API から返さない', async () => {
    const jar = newJar();
    const session = await login(jar);

    await request(jar, 'PUT', '/api/config', {
        headers: { 'X-CSRF-Token': session.csrfToken },
        body: { values: { twitchClientSecret: 'super-secret-value' } }
    });

    const result = await request(jar, 'GET', '/api/config');

    assert.strictEqual(result.body.values.twitchClientSecret.hasValue, true);
    assert.strictEqual(result.body.values.twitchClientSecret.value, null);
    assert.strictEqual(JSON.stringify(result.body).indexOf('super-secret-value'), -1);
});

test('リストの保存と読み出しができる', async () => {
    const jar = newJar();
    const session = await login(jar);

    const saved = await request(jar, 'PUT', '/api/lists/ignoreusers', {
        headers: { 'X-CSRF-Token': session.csrfToken },
        body: { items: ['nightbot', 'nightbot', 'moobot'] }
    });

    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.body.items, ['nightbot', 'moobot']);

    const listed = await request(jar, 'GET', '/api/lists');

    assert.deepStrictEqual(listed.body.ignoreusers.items, ['nightbot', 'moobot']);
    assert.deepStrictEqual(readJson(path.join(ROOT, 'ignoreusers.json')), { ignoreusers: ['nightbot', 'moobot'] });
});

test('未知のリスト ID は 404 を返す', async () => {
    const jar = newJar();
    const session = await login(jar);

    const result = await request(jar, 'PUT', '/api/lists/..%2F..%2Fetc%2Fpasswd', {
        headers: { 'X-CSRF-Token': session.csrfToken },
        body: { items: ['x'] }
    });

    assert.strictEqual(result.status, 404);
});

test('Google Cloud のキーをアップロードすると設定にも反映される', async () => {
    const jar = newJar();
    const session = await login(jar);

    const key = {
        type: 'service_account',
        project_id: 'translate-project',
        private_key: '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n',
        client_email: 'bot@translate-project.iam.gserviceaccount.com'
    };

    const result = await request(jar, 'POST', '/api/google-key', {
        headers: { 'X-CSRF-Token': session.csrfToken },
        body: { fileName: 'my-key.json', content: JSON.stringify(key) }
    });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.path, 'config/my-key.json');

    const local = readJson(path.join(ROOT, 'config', 'local.json'));

    assert.strictEqual(local.config.googleKeyFile, 'config/my-key.json');
    assert.strictEqual(local.config.googleProjectId, 'translate-project');

    const status = await request(jar, 'GET', '/api/google-key');

    assert.strictEqual(status.body.status.valid, true);
    assert.strictEqual(status.body.status.clientEmail, key.client_email);
});

test('サービスアカウントキーでないファイルは拒否される', async () => {
    const jar = newJar();
    const session = await login(jar);

    const result = await request(jar, 'POST', '/api/google-key', {
        headers: { 'X-CSRF-Token': session.csrfToken },
        body: { fileName: 'notes.json', content: JSON.stringify({ hello: 'world' }) }
    });

    assert.strictEqual(result.status, 400);
    assert.ok(result.body.error.indexOf('service_account') !== -1);
});

test('エモートを取得して emoticons.json に追加できる', async () => {
    const jar = newJar();
    const session = await login(jar);

    await request(jar, 'PUT', '/api/lists/emoticons', {
        headers: { 'X-CSRF-Token': session.csrfToken },
        body: { items: ['ManualEmote'] }
    });

    emoteRoutes = {
        'https://api.betterttv.net/3/cached/emotes/global': [{ code: 'GlobalEmote' }],
        'https://api.frankerfacez.com/v1/room/': { room: { set: 7 }, sets: { 7: { emoticons: [{ name: 'RoomEmote' }] } } }
    };

    try {
        const result = await request(jar, 'POST', '/api/emotes/refresh', {
            headers: { 'X-CSRF-Token': session.csrfToken },
            body: { mode: 'merge' }
        });

        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.body.saved, true);
        assert.deepStrictEqual(result.body.items.sort(), ['GlobalEmote', 'ManualEmote', 'RoomEmote']);

        // CLI 用の設定も同じチャンネルに揃う
        assert.strictEqual(readJson(path.join(ROOT, 'config', 'jsonupdate.json')).config.twitchChannel, 'streamer_one');
    } finally {
        emoteRoutes = {};
    }
});

test('すべての取得元が失敗したときは emoticons.json を書き換えない', async () => {
    const jar = newJar();
    const session = await login(jar);

    await request(jar, 'PUT', '/api/lists/emoticons', {
        headers: { 'X-CSRF-Token': session.csrfToken },
        body: { items: ['DoNotDelete'] }
    });

    const result = await request(jar, 'POST', '/api/emotes/refresh', {
        headers: { 'X-CSRF-Token': session.csrfToken },
        body: { mode: 'replace' }
    });

    assert.strictEqual(result.status, 502);
    assert.deepStrictEqual(readJson(path.join(ROOT, 'emoticons.json')), { emoticons: ['DoNotDelete'] });
});

test('概要 API が現在の状態をまとめて返す', async () => {
    const jar = newJar();

    await login(jar);

    const result = await request(jar, 'GET', '/api/overview');

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.channel, 'streamer_one');
    assert.strictEqual(result.body.bot.running, false);
    assert.ok(Array.isArray(result.body.missingRequired));
    assert.strictEqual(result.body.lists.length, 3);
});

test('ログアウトするとセッションが無効になる', async () => {
    const jar = newJar();
    const session = await login(jar);

    const result = await request(jar, 'POST', '/auth/logout', {
        headers: { 'X-CSRF-Token': session.csrfToken },
        body: {}
    });

    assert.strictEqual(result.status, 200);
    assert.strictEqual((await request(jar, 'GET', '/api/session')).status, 401);
});

test('セキュリティ関連のヘッダーが付与される', async () => {
    const jar = newJar();
    const page = await request(jar, 'GET', '/login');

    assert.ok(page.headers.get('content-security-policy').indexOf("default-src 'self'") !== -1);
    assert.strictEqual(page.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(page.headers.get('x-powered-by'), null);
});

// ------------------------------------------------------------------
// 対象チャンネルはログイン中のアカウントに固定する
// ------------------------------------------------------------------

test('ログイン中のアカウント以外のチャンネル・配信者 ID は保存できない', async () => {
    const jar = newJar();
    const session = await login(jar);

    const result = await request(jar, 'PUT', '/api/config', {
        headers: { 'X-CSRF-Token': session.csrfToken },
        body: { values: { twitchChannel: 'someone_else', twitchBroadcasterId: '999999', coolDownCount: '7' } }
    });

    assert.strictEqual(result.status, 400);
    assert.ok(result.body.fieldErrors.twitchChannel.indexOf('streamer_one') !== -1);
    assert.ok(result.body.fieldErrors.twitchBroadcasterId);

    // 1 項目でも拒否されたら、他の項目も保存しない
    const local = readJson(path.join(ROOT, 'config', 'local.json'));

    assert.strictEqual(local.config.twitchChannel, 'streamer_one');
    assert.notStrictEqual(local.config.coolDownCount, 7);
    assert.ok(logs.some(([level, msg]) => level === 'warn' && msg.indexOf('チャンネル設定を拒否') !== -1));
});

test('ログイン名は大文字小文字を区別せずに受け付ける', async () => {
    const jar = newJar();
    const session = await login(jar);

    const result = await request(jar, 'PUT', '/api/config', {
        headers: { 'X-CSRF-Token': session.csrfToken },
        body: { values: { twitchChannel: 'Streamer_One' } }
    });

    assert.strictEqual(result.status, 200);
});

test('エモート取得はリクエストで指定したチャンネルを無視し、設定済みのチャンネルを使う', async () => {
    const jar = newJar();
    const session = await login(jar);

    await request(jar, 'PUT', '/api/config', {
        headers: { 'X-CSRF-Token': session.csrfToken },
        body: { values: { twitchChannel: 'streamer_one', twitchBroadcasterId: '111222' } }
    });

    emoteRoutes = { 'https://api.betterttv.net/3/cached/emotes/global': [{ code: 'GlobalEmote' }] };

    try {
        const result = await request(jar, 'POST', '/api/emotes/refresh', {
            headers: { 'X-CSRF-Token': session.csrfToken },
            body: { mode: 'merge', save: false, channel: 'someone_else', userId: '999999' }
        });

        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.body.channel, 'streamer_one');
        assert.strictEqual(result.body.userId, '111222');
    } finally {
        emoteRoutes = {};
    }
});

test('設定ファイルのチャンネルがログイン中のアカウントと異なると、エモート取得を拒否し概要で警告する', async () => {
    const jar = newJar();
    const session = await login(jar);
    const localPath = path.join(ROOT, 'config', 'local.json');
    const original = readJson(localPath);

    // 設定ファイルを直接書き換えた場合を再現する
    writeJson(localPath, { config: Object.assign({}, original.config, { twitchChannel: 'someone_else' }) });

    try {
        const refresh = await request(jar, 'POST', '/api/emotes/refresh', {
            headers: { 'X-CSRF-Token': session.csrfToken },
            body: { mode: 'merge' }
        });

        assert.strictEqual(refresh.status, 409);

        const overview = await request(jar, 'GET', '/api/overview');

        assert.strictEqual(overview.body.channelMatchesLogin, false);
        assert.strictEqual(overview.body.loginChannel, 'streamer_one');
    } finally {
        writeJson(localPath, original);
    }

    const restored = await request(jar, 'GET', '/api/overview');

    assert.strictEqual(restored.body.channelMatchesLogin, true);
});

test('設定 API は固定項目に locked を付けて返す', async () => {
    const jar = newJar();

    await login(jar);

    const result = await request(jar, 'GET', '/api/config');
    const locked = result.body.fields.filter((field) => field.locked).map((field) => field.key).sort();

    assert.deepStrictEqual(locked, ['twitchBroadcasterId', 'twitchChannel']);
});

// ------------------------------------------------------------------
// ログの閲覧
// ------------------------------------------------------------------

test('ログは決められたファイルだけを末尾から読める', async () => {
    const jar = newJar();

    await login(jar);

    const fs = require('fs');
    const logDir = path.join(ROOT, 'logs');

    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'twitchchattranslator.log'), [
        '[2026-10-01T10:00:00.000] [INFO] system - Connected to twitch chat channel',
        '[2026-10-01T10:00:01.000] [ERROR] system - Helix refused to post: channel:bot',
        '[2026-10-01T10:00:02.000] [INFO] system - password oauth:abcdef0123456789',
        '[2026-10-01T10:00:03.000] [WARN] system - something odd'
    ].join('\n') + '\n');

    const list = await request(jar, 'GET', '/api/logs');

    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.body.logs.map((log) => log.id), ['bot', 'webui', 'emotes']);
    assert.strictEqual(list.body.logs[0].exists, true);

    const last2 = await request(jar, 'GET', '/api/logs/bot?lines=2');

    assert.strictEqual(last2.body.lines.length, 2);
    assert.ok(last2.body.lines[1].indexOf('something odd') !== -1);
    // トークンらしき文字列は伏せる
    assert.ok(last2.body.lines[0].indexOf('oauth:***') !== -1);
    assert.strictEqual(JSON.stringify(last2.body).indexOf('abcdef0123456789'), -1);

    const problems = await request(jar, 'GET', '/api/logs/bot?level=warn');

    assert.strictEqual(problems.body.lines.length, 2);
    assert.ok(problems.body.lines.every((line) => /\[(WARN|ERROR)\]/.test(line)));

    const missing = await request(jar, 'GET', '/api/logs/emotes');

    assert.strictEqual(missing.status, 200);
    assert.strictEqual(missing.body.exists, false);

    assert.strictEqual((await request(jar, 'GET', '/api/logs/..%2F..%2Fconfig%2Fdefault.json')).status, 404);
    assert.strictEqual((await request(jar, 'GET', '/api/logs/unknown')).status, 404);
});

test('未ログインではログを読めない', async () => {
    const jar = newJar();

    assert.strictEqual((await request(jar, 'GET', '/api/logs')).status, 401);
    assert.strictEqual((await request(jar, 'GET', '/api/logs/bot')).status, 401);
});
