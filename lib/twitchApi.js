'use strict';

/**
 * Twitch の Helix API と OAuth の呼び出し（仕様書 7 節）。
 * fetch を差し替えられるようにして、テストでは Twitch に接続しない。
 */

const HELIX = 'https://api.twitch.tv/helix';
const OAUTH = 'https://id.twitch.tv/oauth2';

class TwitchApiError extends Error {
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}

/**
 * @param {{ clientId: string, clientSecret: string, fetch?: function, now?: function }} options
 */
function createTwitchApi(options) {
    const clientId = options.clientId;
    const clientSecret = options.clientSecret;
    const fetchFn = options.fetch || globalThis.fetch;
    const now = options.now || Date.now;

    let appToken = null;
    let appTokenExpiresAt = 0;
    let appTokenPromise = null;

    async function readBody(res) {
        const text = await res.text();

        try {
            return text ? JSON.parse(text) : null;
        } catch (err) {
            return text;
        }
    }

    async function oauth(path, params) {
        const res = await fetchFn(OAUTH + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params).toString()
        });
        const body = await readBody(res);

        if (!res.ok) {
            throw new TwitchApiError('Twitch OAuth ' + path + ' failed: ' + res.status, res.status, body);
        }

        return body;
    }

    /** App Access Token（有効期限の 5 分前までは使い回す） */
    async function getAppToken() {
        if (appToken && now() < appTokenExpiresAt - 5 * 60 * 1000) {
            return appToken;
        }

        if (!appTokenPromise) {
            appTokenPromise = oauth('/token', {
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'client_credentials'
            }).then((data) => {
                appToken = data.access_token;
                appTokenExpiresAt = now() + Number(data.expires_in || 0) * 1000;
                return appToken;
            }).finally(() => {
                appTokenPromise = null;
            });
        }

        return appTokenPromise;
    }

    function invalidateAppToken() {
        appToken = null;
        appTokenExpiresAt = 0;
    }

    function appTokenInfo() {
        return appToken ? { token: appToken, expiresAt: appTokenExpiresAt } : null;
    }

    /** 管理プロセスから配られた App Access Token を使う（bot 側） */
    function setAppToken(token, expiresAt) {
        appToken = token;
        appTokenExpiresAt = expiresAt;
    }

    /**
     * Helix の呼び出し。token を省略すると App Access Token を使い、401 なら取り直して 1 回だけやり直す。
     */
    async function helix(method, path, opts) {
        const o = opts || {};
        const useApp = !o.token;
        let token = o.token || await getAppToken();
        const query = o.query ? '?' + new URLSearchParams(o.query).toString() : '';

        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await fetchFn(HELIX + path + query, {
                method,
                headers: Object.assign({
                    'Authorization': 'Bearer ' + token,
                    'Client-Id': clientId
                }, o.body ? { 'Content-Type': 'application/json' } : {}),
                body: o.body ? JSON.stringify(o.body) : undefined
            });

            if (res.status === 401 && useApp && attempt === 0) {
                invalidateAppToken();
                token = await getAppToken();
                continue;
            }

            const body = await readBody(res);

            if (!res.ok) {
                throw new TwitchApiError('Helix ' + method + ' ' + path + ' failed: ' + res.status, res.status, body);
            }

            return body;
        }

        throw new TwitchApiError('Helix ' + method + ' ' + path + ' failed after token refresh', 401, null);
    }

    return {
        getAppToken,
        invalidateAppToken,
        appTokenInfo,
        setAppToken,
        helix,

        /** 翻訳の投稿（App Access Token。bot バッジが付く） */
        async sendChatMessage(broadcasterId, senderId, message, replyParentMessageId) {
            const body = { broadcaster_id: String(broadcasterId), sender_id: String(senderId), message: String(message) };

            if (replyParentMessageId) { body.reply_parent_message_id = String(replyParentMessageId); }

            const data = await helix('POST', '/chat/messages', { body });
            const row = data && Array.isArray(data.data) ? data.data[0] : null;

            return {
                sent: !!(row && row.is_sent),
                messageId: row ? row.message_id || null : null,
                dropReason: row && row.drop_reason ? row.drop_reason : null
            };
        },

        /** チャットのメッセージの削除（モデレーターのユーザートークン） */
        async deleteChatMessage(broadcasterId, moderatorId, messageId, userToken) {
            await helix('DELETE', '/moderation/chat', {
                token: userToken,
                query: { broadcaster_id: String(broadcasterId), moderator_id: String(moderatorId), message_id: String(messageId) }
            });
        },

        /** 配信中かどうか */
        async isLive(broadcasterId) {
            const data = await helix('GET', '/streams', { query: { user_id: String(broadcasterId) } });

            return !!(data && Array.isArray(data.data) && data.data.some((stream) => stream.type === 'live'));
        },

        async createSubscription(type, version, condition, callback, secret) {
            const data = await helix('POST', '/eventsub/subscriptions', {
                body: { type, version, condition, transport: { method: 'webhook', callback, secret } }
            });

            return data && Array.isArray(data.data) ? data.data[0] : null;
        },

        /** 購読の一覧（ページをすべてたどる） */
        async listSubscriptions() {
            const all = [];
            let after = null;

            for (let page = 0; page < 50; page++) {
                const data = await helix('GET', '/eventsub/subscriptions', { query: after ? { after } : {} });

                all.push(...(data && Array.isArray(data.data) ? data.data : []));
                after = data && data.pagination ? data.pagination.cursor : null;

                if (!after) { break; }
            }

            return all;
        },

        async deleteSubscription(id) {
            await helix('DELETE', '/eventsub/subscriptions', { query: { id: String(id) } });
        },

        /** ユーザートークンの更新 */
        async refreshUserToken(refreshToken) {
            const data = await oauth('/token', {
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            });

            return {
                accessToken: data.access_token,
                refreshToken: data.refresh_token || refreshToken,
                expiresAt: now() + Number(data.expires_in || 0) * 1000,
                scopes: Array.isArray(data.scope) ? data.scope : []
            };
        },

        /** トークンの無効化（チャンネルの削除時など。失敗しても例外にしない） */
        async revokeToken(token) {
            try {
                await oauth('/revoke', { client_id: clientId, token });
                return true;
            } catch (err) {
                return false;
            }
        }
    };
}

module.exports = { createTwitchApi, TwitchApiError };
