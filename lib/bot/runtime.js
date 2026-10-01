'use strict';

const { decide, Cooldown } = require('./translator');
const { readJson, writeJsonAtomic } = require('../fileStore');

/**
 * bot の本体（チャンネルごとに 1 プロセス。仕様書 8 節）。
 * 管理プロセスから IPC で EventSub のイベントを受け取り、翻訳して Helix で投稿する。IRC は使わない。
 * 依存（Twitch API・Google 翻訳・リスト・ログ・時刻）はすべて外から渡す。
 *
 * ログには視聴者の発言の本文を書かない（D19）。障害の調査に必要な ID・長さ・判定の理由だけを書く。
 */

const MESSAGE_MAP_TTL = 6 * 60 * 60 * 1000;   // Twitch が削除を受け付けるのは 6 時間以内のメッセージ

/**
 * @param {object} deps
 * @param {{ broadcasterId: string, coolDownCount: number, dailyCharLimit: number }} deps.config
 * @param {string} deps.tokensFile secrets/bot-tokens.json
 * @param {object} deps.api lib/twitchApi.js
 * @param {{ detect: function, translate: function }} deps.translate Google の Translate（v2）互換
 * @param {{ read: function(id) }} deps.lists lib/lists.forChannel(login)
 * @param {object} deps.usage lib/bot/usage.js の Usage
 * @param {object} deps.logger
 * @param {function} [deps.now]
 */
function createBot(deps) {
    const config = deps.config;
    const api = deps.api;
    const logger = deps.logger;
    const now = deps.now || Date.now;
    const cooldown = new Cooldown(now);
    const messageMap = new Map();
    const state = { streamLive: null, lists: { ignoreUsers: [], ignoreLines: [], emotes: [] }, capLoggedFor: null };

    let tokens = loadTokens();

    function loadTokens() {
        const result = readJson(deps.tokensFile);

        if (!result.data || !result.data.accessToken || !result.data.userId) {
            throw new Error('bot アカウントのトークンがありません: ' + deps.tokensFile);
        }

        return result.data;
    }

    function saveTokens() {
        writeJsonAtomic(deps.tokensFile, tokens, { mode: 0o600, backup: false });
    }

    /** 削除に使う bot のユーザートークン。期限の 5 分前を過ぎていたら更新する */
    async function userToken(force) {
        const expiresAt = Number(tokens.expiresAt || 0);

        if (!force && expiresAt > 0 && now() < expiresAt - 5 * 60 * 1000) {
            return tokens.accessToken;
        }
        if (!force && expiresAt === 0) {
            return tokens.accessToken;
        }

        const fresh = await api.refreshUserToken(tokens.refreshToken);

        tokens = Object.assign({}, tokens, fresh);
        saveTokens();
        logger.info('bot のユーザートークンを更新しました');

        return tokens.accessToken;
    }

    function reloadLists() {
        const read = (id) => {
            const result = deps.lists.read(id);

            if (result.error) { logger.error('リストを読み込めません: ' + result.error); }
            return result.items;
        };

        state.lists = { ignoreUsers: read('ignoreusers'), ignoreLines: read('ignoreline'), emotes: read('emoticons') };
        logger.info('リストを読み込みました: 除外ユーザー ' + state.lists.ignoreUsers.length + ' / 除外する行 ' +
            state.lists.ignoreLines.length + ' / エモート ' + state.lists.emotes.length);
    }

    function cleanupMessageMap() {
        const current = now();

        for (const [key, value] of messageMap) {
            if (current - value.timestamp > MESSAGE_MAP_TTL) { messageMap.delete(key); }
        }
        cooldown.prune();
    }

    async function deleteTranslation(botMessageId) {
        try {
            await api.deleteChatMessage(config.broadcasterId, tokens.userId, botMessageId, await userToken(false));
        } catch (err) {
            if (err.status === 401) {
                await api.deleteChatMessage(config.broadcasterId, tokens.userId, botMessageId, await userToken(true));
            } else {
                throw err;
            }
        }
    }

    async function onChatMessage(event) {
        const decision = decide(event, {
            broadcasterId: config.broadcasterId,
            botUserId: tokens.userId,
            lists: state.lists,
            streamLive: state.streamLive,
            cooldown,
            coolDownCount: config.coolDownCount
        });

        if (decision.action === 'ignore') {
            logger.debug('翻訳しません: ' + decision.reason + ' message_id=' + event.message_id);
            return { result: 'ignored', reason: decision.reason };
        }

        if (decision.action === 'command') {
            reloadLists();
            logger.info('コマンドでリストを読み直しました: ' + decision.list + ' by ' + event.chatter_user_login);
            return { result: 'command', list: decision.list };
        }

        if (deps.usage.exceeded(config.dailyCharLimit)) {
            const today = new Date(now()).toDateString();

            if (state.capLoggedFor !== today) {
                state.capLoggedFor = today;
                logger.warn('1 日の翻訳文字数の上限（' + config.dailyCharLimit + '）に達したため、今日は翻訳しません');
            }
            return { result: 'ignored', reason: 'daily_limit' };
        }

        const text = decision.text;
        let detections;
        let translations;

        try {
            [detections] = await deps.translate.detect(text);
            [translations] = await deps.translate.translate(text, decision.toLang);
        } catch (err) {
            logger.error('翻訳 API の呼び出しに失敗しました message_id=' + event.message_id + ': ' + err.message);
            return { result: 'error', reason: 'translate_failed' };
        }

        deps.usage.add(text.length * 2);   // detect と translate の両方で課金される

        const detection = Array.isArray(detections) ? detections[detections.length - 1] : detections;
        const fromLang = detection && detection.language ? detection.language : 'und';
        const translated = Array.isArray(translations) ? translations.join(' ') : String(translations);
        const message = translated + ' (source lang: ' + fromLang + ')';

        try {
            const sent = await api.sendChatMessage(config.broadcasterId, tokens.userId, message);

            if (!sent.sent) {
                logger.warn('翻訳を投稿できませんでした message_id=' + event.message_id + ' drop_reason=' + JSON.stringify(sent.dropReason));
                return { result: 'error', reason: 'not_sent' };
            }

            if (sent.messageId) {
                messageMap.set(event.message_id, { botMessageId: sent.messageId, login: String(event.chatter_user_login || '').toLowerCase(), timestamp: now() });
            }

            logger.info('翻訳を投稿しました message_id=' + event.message_id + ' chars=' + text.length + ' ' + fromLang + '->' + decision.toLang);
            return { result: 'translated', botMessageId: sent.messageId };
        } catch (err) {
            if (err.status === 403) {
                logger.error('Helix が投稿を拒否しました（チャンネル主が bot を許可していない（channel:bot）か、bot がモデレーターでない可能性）。' +
                    'IRC での代替投稿はしません。message_id=' + event.message_id);
            } else {
                logger.error('翻訳を投稿できませんでした message_id=' + event.message_id + ': ' + err.message);
            }
            return { result: 'error', reason: 'send_failed' };
        }
    }

    async function onMessageDelete(event) {
        const mapping = messageMap.get(event.message_id);

        if (!mapping) { return { deleted: 0 }; }

        messageMap.delete(event.message_id);
        await deleteTranslation(mapping.botMessageId);
        logger.info('元の発言が削除されたので翻訳も削除しました message_id=' + event.message_id);

        return { deleted: 1 };
    }

    async function onClearUserMessages(event) {
        const login = String(event.target_user_login || '').toLowerCase();
        let deleted = 0;

        for (const [originalId, mapping] of messageMap) {
            if (mapping.login === login) {
                messageMap.delete(originalId);
                try {
                    await deleteTranslation(mapping.botMessageId);
                    deleted++;
                } catch (err) {
                    logger.error('翻訳を削除できませんでした: ' + err.message);
                }
            }
        }

        if (deleted > 0) {
            logger.info('BAN またはタイムアウトにより翻訳を ' + deleted + ' 件削除しました user_id=' + event.target_user_id);
        }

        return { deleted };
    }

    function setStreamLive(live, why) {
        if (state.streamLive !== live) {
            logger.info('Stream status changed: ' + label(state.streamLive) + ' -> ' + label(live) + ' (' + why + ')');
            state.streamLive = live;
        }
    }

    function label(v) {
        return v === null ? 'unknown' : (v ? 'live' : 'offline');
    }

    /** 管理プロセスから届いた EventSub のイベント */
    async function handleEvent(type, event) {
        if (String(event.broadcaster_user_id) !== String(config.broadcasterId)) {
            logger.warn('別のチャンネルのイベントを無視しました: ' + type);
            return { result: 'ignored', reason: 'other_channel' };
        }

        switch (type) {
            case 'channel.chat.message': return onChatMessage(event);
            case 'channel.chat.message_delete': return onMessageDelete(event);
            case 'channel.chat.clear_user_messages': return onClearUserMessages(event);
            case 'stream.online': setStreamLive(true, 'stream.online'); return { result: 'live' };
            case 'stream.offline': setStreamLive(false, 'stream.offline'); return { result: 'offline' };
            default:
                logger.warn('未対応のイベントを無視しました: ' + type);
                return { result: 'ignored', reason: 'unsupported' };
        }
    }

    /** 起動時: リストを読み、配信状態を一度だけ問い合わせる（以後は stream.online / offline で更新） */
    async function start() {
        reloadLists();

        try {
            setStreamLive(await api.isLive(config.broadcasterId), 'Get Streams');
        } catch (err) {
            logger.warn('配信状態を取得できません。分かるまでは全員の発言を翻訳します: ' + err.message);
        }
    }

    return { start, handleEvent, reloadLists, cleanupMessageMap, state, messageMap, tokens: () => tokens };
}

module.exports = { createBot, MESSAGE_MAP_TTL };
