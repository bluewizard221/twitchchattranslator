'use strict';

const crypto = require('crypto');
const paths = require('../../lib/paths');
const { readJson } = require('../../lib/fileStore');
const sharedConfig = require('../../lib/sharedConfig');
const { loadOperators } = require('./operators');

/**
 * 管理画面自身の設定を読み込む。
 * 優先順位: 環境変数  >  config/webui.json。
 * Twitch アプリの Client ID / Secret は共通の設定（lib/sharedConfig.js: config/default.json → local.json → 環境変数）から読む。
 * WEBUI_TWITCH_CLIENT_ID / WEBUI_TWITCH_CLIENT_SECRET があればそちらを優先する（試用時の互換）。
 */
function load() {
    const fileResult = readJson(paths.WEBUI_CONFIG);
    const file = fileResult.data && typeof fileResult.data === 'object' ? fileResult.data : {};
    const fileError = fileResult.error;

    const port = toPort(pick(process.env.WEBUI_PORT, file.port), 3000);
    const host = pick(process.env.WEBUI_HOST, file.host) || '127.0.0.1';

    const shared = safeSharedConfig();

    const clientId = str(pick(process.env.WEBUI_TWITCH_CLIENT_ID, shared.twitchClientId));
    const clientSecret = str(pick(process.env.WEBUI_TWITCH_CLIENT_SECRET, shared.twitchClientSecret));
    const redirectUri = str(pick(process.env.WEBUI_REDIRECT_URI, file.redirectUri)) ||
        ('http://localhost:' + port + '/auth/twitch/callback');

    const allowedUsers = toList(pick(process.env.WEBUI_ALLOWED_USERS, file.allowedUsers))
        .map((name) => name.toLowerCase());

    const sessionSecretRaw = str(pick(process.env.WEBUI_SESSION_SECRET, file.sessionSecret));
    const sessionSecret = sessionSecretRaw || crypto.randomBytes(32).toString('hex');

    const trustProxy = toBool(pick(process.env.WEBUI_TRUST_PROXY, file.trustProxy), false);
    const secureCookie = toBool(
        pick(process.env.WEBUI_SECURE_COOKIE, file.secureCookie),
        redirectUri.startsWith('https://')
    );

    const warnings = [];
    const errors = [];

    if (fileError) {
        errors.push('config/webui.json を読み込めません。' + fileError);
    }
    if (!clientId || !clientSecret) {
        errors.push('Twitch アプリの Client ID / Client Secret が設定されていません。' +
            'config/default.json（または config/local.json）の twitchClientId / twitchClientSecret を設定してください。');
    }
    if (loadOperators(allowedUsers).length === 0) {
        errors.push('運営者が 1 人も設定されていません。' +
            'config/operators.json の operators、環境変数 WEBUI_OPERATORS、または config/webui.json の allowedUsers（旧形式）に Twitch のログイン名を設定してください。');
    }
    if (!sessionSecretRaw) {
        warnings.push('WEBUI_SESSION_SECRET が未設定のため、起動ごとにランダムな値を生成しました。' +
            'サーバーを再起動するとログイン状態は失われます。');
    }

    return {
        port,
        host,
        clientId,
        clientSecret,
        redirectUri,
        allowedUsers,
        sessionSecret,
        trustProxy,
        secureCookie,
        sessionMaxAgeMs: toInt(pick(process.env.WEBUI_SESSION_HOURS, file.sessionHours), 12) * 60 * 60 * 1000,
        maxSessions: toInt(pick(process.env.WEBUI_MAX_SESSIONS, file.maxSessions), 1000),
        rateLimitAuthPerMinute: toInt(pick(process.env.WEBUI_RATE_LIMIT_AUTH, file.rateLimitAuthPerMinute), 30),
        rateLimitApiPerMinute: toInt(pick(process.env.WEBUI_RATE_LIMIT_API, file.rateLimitApiPerMinute), 600),
        warnings,
        errors
    };
}

function safeSharedConfig() {
    try {
        return sharedConfig.load();
    } catch (err) {
        return {};
    }
}

function pick() {
    for (const value of arguments) {
        if (value !== undefined && value !== null && value !== '') { return value; }
    }
    return undefined;
}

function str(value) {
    return value === undefined || value === null ? '' : String(value).trim();
}

function toList(value) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item).trim()).filter((item) => item !== '');
    }
    if (typeof value === 'string') {
        return value.split(/[,\s]+/).map((item) => item.trim()).filter((item) => item !== '');
    }
    return [];
}

function toBool(value, fallback) {
    if (value === undefined || value === null || value === '') { return fallback; }
    if (typeof value === 'boolean') { return value; }

    const text = String(value).toLowerCase();

    return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function toInt(value, fallback) {
    const num = Number(value);

    return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function toPort(value, fallback) {
    const num = Number(value);

    return Number.isInteger(num) && num > 0 && num < 65536 ? num : fallback;
}

module.exports = { load };
