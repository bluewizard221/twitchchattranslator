'use strict';

const fs = require('fs');
const paths = require('../../lib/paths');
const { readJson, writeJsonAtomic } = require('../../lib/fileStore');

/**
 * bot アカウントの接続（仕様書 6 節の手順 3）。
 * 配信者が bot アカウントで Twitch にログインし直して許可すると、トークンと bot の ID を
 * channels/<login>/secrets/bot-tokens.json（0600）に保存する。トークンは画面にも API にも返さない。
 */

// EventSub の受信（user:read:chat）、bot としての参加（user:bot）、投稿（user:write:chat）、翻訳の削除（moderator:manage:chat_messages）
const REQUIRED_SCOPES = ['user:read:chat', 'user:bot', 'user:write:chat', 'moderator:manage:chat_messages'];

/** 接続の状態（トークンは返さない） */
function status(login) {
    const result = readJson(paths.channel(login).botTokens);
    const data = result.data;

    if (!data || !data.userId) {
        return { connected: false };
    }

    const scopes = Array.isArray(data.scopes) ? data.scopes : [];

    return {
        connected: true,
        botLogin: data.login || null,
        botUserId: String(data.userId),
        connectedAt: data.connectedAt || null,
        scopes,
        missingScopes: REQUIRED_SCOPES.filter((scope) => scopes.indexOf(scope) === -1)
    };
}

/**
 * OAuth で得たトークンを保存する。
 * @param {string} login チャンネル
 * @param {{ access_token, refresh_token, expires_in, scope }} token Twitch のトークン応答
 * @param {{ id, login }} botUser トークンの持ち主（bot アカウント）
 * @param {string} broadcasterId チャンネル主の ID
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function save(login, token, botUser, broadcasterId) {
    const scopes = Array.isArray(token.scope) ? token.scope : [];
    const missing = REQUIRED_SCOPES.filter((scope) => scopes.indexOf(scope) === -1);

    if (missing.length > 0) {
        return { ok: false, error: '必要な許可が足りません: ' + missing.join(', ') };
    }
    if (broadcasterId && String(botUser.id) === String(broadcasterId)) {
        return {
            ok: false,
            error: 'チャンネル主のアカウントで許可されたため、接続しませんでした（bot 自身の発言は翻訳しないので、チャンネル主のアカウントは bot に使えません）。' +
                'Twitch にチャンネル主でログインしたままだと、アカウントを選ぶ画面は出ません。' +
                'この管理画面はログインしたままで、別のタブで twitch.tv をログアウトしてから、もう一度「bot アカウントを接続」を押し、bot 用のアカウントでログインしてください。'
        };
    }
    if (!token.access_token || !token.refresh_token) {
        return { ok: false, error: 'トークンを受け取れませんでした。' };
    }

    writeJsonAtomic(paths.channel(login).botTokens, {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + Number(token.expires_in || 0) * 1000,
        userId: String(botUser.id),
        login: String(botUser.login),
        scopes,
        connectedAt: new Date().toISOString()
    }, { mode: 0o600, backup: false });

    return { ok: true };
}

/** 保存しているトークン（無効化に使う。画面には返さないこと） */
function readTokens(login) {
    const result = readJson(paths.channel(login).botTokens);

    return result.data && result.data.accessToken ? result.data : null;
}

/** 保存しているトークンを削除する（無効化は呼び出し側で先に行う） */
function remove(login) {
    const file = paths.channel(login).botTokens;

    if (!fs.existsSync(file)) { return false; }

    fs.unlinkSync(file);

    return true;
}

module.exports = { REQUIRED_SCOPES, status, save, readTokens, remove };
