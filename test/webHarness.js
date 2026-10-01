'use strict';

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempRoot, writeJson } = require('./helpers');

/**
 * 管理画面のテスト用の土台。
 * 一時ディレクトリにプロジェクトを作り、Twitch への通信と管理プロセスを偽物に差し替えたアプリを起動する。
 *
 * 利用者:
 *   op_admin  運営者（自分のチャンネルなし）
 *   alice     配信者（ID 100）。bot アカウントは alice_bot（ID 101）
 *   bob       配信者（ID 200）。bot アカウントは bob_bot（ID 201）
 *   viewer    未登録のユーザー（ID 999）
 *
 * 認可コード（code）は "<ログイン名>" または "<ログイン名>:<スコープ,...>" の形で、
 * 偽の Twitch はそのユーザーのトークンを返す。
 * テストファイルごとに別プロセスで動くので、require の前にこのファイルを読み込むこと。
 */

const ROOT = useTempRoot();

writeJson(path.join(ROOT, 'config', 'default.json'), {
    config: { twitchClientId: 'testclientid01', twitchClientSecret: 'test-client-secret' }
});

process.env.WEBUI_OPERATORS = 'op_admin';
process.env.WEBUI_SESSION_SECRET = 'test-session-secret';
process.env.WEBUI_REDIRECT_URI = 'http://localhost:3000/auth/twitch/callback';
process.env.WEBUI_RATE_LIMIT_AUTH = '10000';
process.env.WEBUI_RATE_LIMIT_API = '10000';
delete process.env.WEBUI_TWITCH_CLIENT_ID;
delete process.env.WEBUI_TWITCH_CLIENT_SECRET;

const paths = require('../lib/paths');
const channels = require('../lib/channels');
const webConfig = require('../web/lib/webConfig');
const { createApp } = require('../web/app');

const USERS = {
    op_admin: { id: '900', login: 'op_admin', display_name: 'Op Admin' },
    alice: { id: '100', login: 'alice', display_name: 'Alice' },
    alice_bot: { id: '101', login: 'alice_bot', display_name: 'AliceBot' },
    bob: { id: '200', login: 'bob', display_name: 'Bob' },
    bob_bot: { id: '201', login: 'bob_bot', display_name: 'BobBot' },
    viewer: { id: '999', login: 'viewer', display_name: 'Viewer' }
};

const BOT_SCOPES = ['user:read:chat', 'user:bot', 'user:write:chat', 'moderator:manage:chat_messages'];

const realFetch = globalThis.fetch.bind(globalThis);

// 偽の Twitch が発行・無効化したトークン
const twitch = { issued: 0, tokens: new Map(), revoked: [] };

globalThis.fetch = async (url, options) => {
    const target = String(url);

    if (target.startsWith('https://id.twitch.tv/oauth2/token')) {
        const params = new URLSearchParams(String(options.body));
        // スコープ自体に ":" が入るので、最初の ":" だけで分ける
        const code = String(params.get('code'));
        const sep = code.indexOf(':');
        const login = sep === -1 ? code : code.slice(0, sep);
        const scopeText = sep === -1 ? undefined : code.slice(sep + 1);
        const user = USERS[login];

        if (!user) { return jsonResponse({ message: 'invalid code' }, 400); }

        const n = ++twitch.issued;
        const token = {
            access_token: 'access-' + login + '-' + n,
            refresh_token: 'refresh-' + login + '-' + n,
            expires_in: 14400,
            scope: scopeText === undefined ? ['channel:bot'] : scopeText.split(',').filter(Boolean),
            token_type: 'bearer'
        };

        twitch.tokens.set(token.access_token, user);

        return jsonResponse(token);
    }
    if (target.startsWith('https://id.twitch.tv/oauth2/revoke')) {
        twitch.revoked.push(new URLSearchParams(String(options.body)).get('token'));
        return jsonResponse({});
    }
    if (target.startsWith('https://api.twitch.tv/helix/users')) {
        const auth = options.headers.Authorization || '';
        const user = twitch.tokens.get(auth.replace(/^Bearer /, ''));

        return user ? jsonResponse({ data: [user] }) : jsonResponse({ message: 'invalid token' }, 401);
    }

    return realFetch(url, options);
};

function jsonResponse(body, status) {
    const code = status || 200;
    const text = JSON.stringify(body);

    return { ok: code < 400, status: code, statusText: String(code), json: async () => body, text: async () => text };
}

/** 偽の管理プロセス。受けた依頼を記録し、bot の状態をテストから操作できる */
function createFakeManager() {
    const fake = {
        requests: [],
        running: new Set(),
        connected: true,
        available: () => fake.connected,
        async request(action, payload) {
            fake.requests.push({ action, payload: payload || {} });

            if (!fake.connected) { throw new Error('管理プロセスに接続されていません'); }

            const login = payload && payload.login;

            switch (action) {
            case 'status': {
                const bots = {};

                for (const meta of channels.list()) {
                    bots[meta.login] = { enabled: true, ready: false, missing: [], process: fake.running.has(meta.login) ? { state: 'running', restarts: 0 } : null };
                }
                return { status: 'ok', bots, eventsub: { configured: true } };
            }
            case 'channel.start': fake.running.add(login); return { process: { state: 'running' } };
            case 'channel.stop': fake.running.delete(login); return { process: null };
            case 'channel.restart': return { process: { state: 'running' } };
            case 'channel.reload': return { sent: fake.running.has(login) };
            case 'emotes.refresh': return { ok: true, count: 3, warnings: [] };
            case 'eventsub.sync': return { created: 0, deleted: 5, errors: [] };
            case 'channels.changed': return {};
            default: throw new Error('unknown action ' + action);
            }
        },
        /** 指定したチャンネルを対象にした依頼 */
        requestsFor(login) {
            return fake.requests.filter((r) => r.payload && r.payload.login === login);
        }
    };

    return fake;
}

const logLines = [];
const logger = {
    info: (msg) => logLines.push(['info', msg]),
    warn: (msg) => logLines.push(['warn', msg]),
    error: (msg) => logLines.push(['error', msg]),
    debug: () => {}
};

const manager = createFakeManager();
const config = webConfig.load();
const app = createApp(config, logger, { manager });

let baseUrl = null;
let server = null;

async function start() {
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = 'http://127.0.0.1:' + server.address().port;
}

function stop() {
    if (server) { server.close(); }
}

function newJar() {
    return { cookies: {}, csrf: null };
}

/** jar のクッキーと CSRF トークンを付けてリクエストする（csrf: false で付けない） */
async function request(jar, method, url, options) {
    const opts = options || {};
    const headers = Object.assign({ 'Accept': 'application/json' }, opts.headers);
    const cookie = Object.keys(jar.cookies).map((name) => name + '=' + jar.cookies[name]).join('; ');

    if (cookie) { headers.Cookie = cookie; }
    if (jar.csrf && opts.csrf !== false && method !== 'GET') { headers['X-CSRF-Token'] = jar.csrf; }

    const init = { method, headers, redirect: 'manual' };

    if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
    }

    const res = await realFetch((opts.baseUrl || baseUrl) + url, init);

    for (const raw of res.headers.getSetCookie()) {
        const pair = raw.split(';')[0];
        const index = pair.indexOf('=');

        jar.cookies[pair.slice(0, index)] = pair.slice(index + 1);
    }

    const text = await res.text();
    let body = text;

    try { body = JSON.parse(text); } catch (err) { /* JSON 以外 */ }

    return { status: res.status, headers: res.headers, body, text };
}

/** OAuth の往復（/auth/twitch → callback）。戻り値はコールバックの応答 */
async function oauth(jar, startUrl, code) {
    const start = await request(jar, 'GET', startUrl);

    assert.strictEqual(start.status, 302, 'OAuth を開始できません: ' + startUrl + ' ' + start.text);

    const authorize = new URL(start.headers.get('location'));
    const state = authorize.searchParams.get('state');
    const callback = await request(jar, 'GET', '/auth/twitch/callback?code=' + encodeURIComponent(code) + '&state=' + encodeURIComponent(state));

    return { authorize, callback };
}

/** そのユーザーとしてログインしたセッションを返す */
async function loginAs(login, scopes) {
    const jar = newJar();
    const code = scopes === undefined ? login : login + ':' + scopes.join(',');
    const { callback } = await oauth(jar, '/auth/twitch', code);

    assert.strictEqual(callback.headers.get('location'), '/', login + ' としてログインできません');

    const session = await request(jar, 'GET', '/api/session');

    assert.strictEqual(session.status, 200);
    jar.csrf = session.body.csrfToken;
    jar.session = session.body;

    return jar;
}

/** bot アカウントを接続する（配信者のセッションで /auth/bot/:login から） */
async function connectBot(jar, channel, botLogin, scopes) {
    return oauth(jar, '/auth/bot/' + channel, botLogin + ':' + (scopes || BOT_SCOPES).join(','));
}

/** チャンネルを直接登録する（運営者の画面を通さない準備用） */
function registerChannel(login) {
    if (!channels.exists(login)) { channels.create(login, { createdBy: 'test' }); }
}

/** ディレクトリ以下のファイルの内容をまとめて返す（変更されていないことの確認用） */
function snapshotDir(dir) {
    const result = {};

    if (!fs.existsSync(dir)) { return result; }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) { continue; }

        const file = path.join(entry.parentPath || entry.path, entry.name);

        result[path.relative(dir, file)] = fs.readFileSync(file, 'utf8');
    }

    return result;
}

const VALID_KEY = {
    type: 'service_account',
    project_id: 'alice-project',
    private_key_id: 'abc123',
    private_key: '-----BEGIN PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END PRIVATE KEY-----\n',
    client_email: 'translator@alice-project.iam.gserviceaccount.com',
    client_id: '1234567890'
};

module.exports = {
    ROOT, paths, channels, app, config, logger, logLines, manager, twitch, USERS, BOT_SCOPES, VALID_KEY,
    start, stop, newJar, request, oauth, loginAs, connectBot, registerChannel, snapshotDir, createApp, realFetch
};
