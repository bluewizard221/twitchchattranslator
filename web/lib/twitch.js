'use strict';

const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke';
const USERS_URL = 'https://api.twitch.tv/helix/users';

const REQUEST_TIMEOUT_MS = 15000;

/** ログイン用の認可 URL を組み立てる（追加スコープは要求しない） */
function buildAuthorizeUrl(options) {
    const url = new URL(AUTHORIZE_URL);

    url.searchParams.set('client_id', options.clientId);
    url.searchParams.set('redirect_uri', options.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', options.scope || '');
    url.searchParams.set('state', options.state);
    url.searchParams.set('force_verify', options.forceVerify ? 'true' : 'false');

    return url.toString();
}

/** 認可コードをアクセストークンに交換する */
async function exchangeCode(options) {
    const params = new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code: options.code,
        grant_type: 'authorization_code',
        redirect_uri: options.redirectUri
    });

    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        body: params,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const body = await res.text();

    if (!res.ok) {
        throw new Error('アクセストークンの取得に失敗しました（HTTP ' + res.status + '）: ' + body);
    }

    return JSON.parse(body);
}

/**
 * アクセストークンの持ち主の情報を取得する。
 * ここで得られる login / id をそれぞれ twitchChannel / twitchBroadcasterId に利用する。
 */
async function getAuthenticatedUser(options) {
    const res = await fetch(USERS_URL, {
        headers: {
            'Authorization': 'Bearer ' + options.accessToken,
            'Client-Id': options.clientId
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error('ユーザー情報の取得に失敗しました（HTTP ' + res.status + '）: ' + body);
    }

    const data = await res.json();
    const user = data && Array.isArray(data.data) ? data.data[0] : null;

    if (!user) {
        throw new Error('ユーザー情報が空でした。');
    }

    return {
        id: user.id,
        login: user.login,
        displayName: user.display_name,
        profileImageUrl: user.profile_image_url,
        broadcasterType: user.broadcaster_type
    };
}

/** ログアウト時にアクセストークンを失効させる（失敗しても致命的ではない） */
async function revokeToken(options) {
    const params = new URLSearchParams({
        client_id: options.clientId,
        token: options.token
    });

    try {
        await fetch(REVOKE_URL, {
            method: 'POST',
            body: params,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        return true;
    } catch (err) {
        return false;
    }
}

module.exports = { buildAuthorizeUrl, exchangeCode, getAuthenticatedUser, revokeToken };
