'use strict';

/**
 * 翻訳するかどうかの判定（EventSub の channel.chat.message 用）。
 * IRC 版（twitchchattranslator.js の onMessageHandler）のルールと順序をそのまま移している。
 *
 *   1. bot 自身の発言は無視
 *   2. 共有チャット（Shared Chat）でほかのチャンネルから来た発言は無視（各チャンネルの bot が重複して翻訳しないように）
 *   3. 除外する行（正規表現）に当たれば無視
 *   4. コマンド（!refreshignoreuser / !refreshignoreline / !refreshemoticons）はモデレーターとチャンネル主だけ。ほかの ! で始まる発言は無視
 *   5. チャンネル主の発言は常に翻訳。それ以外は配信中のみ（配信状態が不明なら翻訳する）
 *   6. 除外するユーザーは無視
 *   7. クールダウン（モデレーターとチャンネル主は対象外）
 *   8. エモートを取り除き、何も残らなければ無視
 */

const COMMANDS = {
    '!refreshignoreuser': 'ignoreusers',
    '!refreshignoreline': 'ignoreline',
    '!refreshemoticons': 'emoticons'
};

// 日本語（ひらがな・カタカナ・漢字など）を含むかどうか。含めば英語へ、含まなければ日本語へ翻訳する
const JP_RE = /[゠-ヿ぀-ゟ々-〆ム-鿏]/;

function hasBadge(event, setId) {
    return Array.isArray(event.badges) && event.badges.some((badge) => badge && badge.set_id === setId);
}

function isBroadcaster(event, broadcasterId) {
    return String(event.chatter_user_id) === String(broadcasterId) || hasBadge(event, 'broadcaster');
}

function isPrivileged(event, broadcasterId) {
    return isBroadcaster(event, broadcasterId) || hasBadge(event, 'moderator');
}

/**
 * クールダウン（同一ユーザーの 1 分あたりの翻訳回数）。IRC 版と同じ数え方:
 * 1 分以内の発言ごとに数を増やし、数が coolDownCount 以上になったら翻訳しない。1 分を過ぎたら 1 から数え直す。
 */
class Cooldown {
    constructor(now) {
        this.now = now || Date.now;
        this.users = new Map();
    }

    isSpamming(login, limit) {
        const current = this.now();
        const entry = this.users.get(login);

        if (!entry) {
            this.users.set(login, { count: 1, latest: current });
            return false;
        }

        if (current - entry.latest <= 60000) {
            entry.count++;
        } else {
            entry.count = 1;
            entry.latest = current;
        }

        return entry.count >= limit;
    }

    /** 古い記録を捨てる（メモリを増やし続けないように） */
    prune() {
        const current = this.now();

        for (const [login, entry] of this.users) {
            if (current - entry.latest > 60000) { this.users.delete(login); }
        }
    }
}

/** Twitch のエモートは断片の種類で、BTTV / FFZ のエモートは一覧との照合で取り除く */
function removeEmotes(event, thirdPartyEmotes) {
    const fragments = event.message && Array.isArray(event.message.fragments) ? event.message.fragments : null;
    const text = fragments
        ? fragments.filter((f) => f && f.type !== 'emote').map((f) => f.text || '').join('')
        : String(event.message && event.message.text || '');

    const emoteSet = new Set(thirdPartyEmotes || []);

    return text.split(' ').filter((word) => !emoteSet.has(word)).join(' ').trim();
}

function matchesIgnoreLine(line, patterns) {
    for (const pattern of patterns || []) {
        try {
            if (new RegExp(pattern).test(line)) { return pattern; }
        } catch (err) {
            // 壊れた正規表現は無視する（保存時に検証しているので通常は起きない）
        }
    }
    return null;
}

/**
 * @param {object} event channel.chat.message の event
 * @param {object} ctx
 * @param {string} ctx.broadcasterId
 * @param {string} ctx.botUserId
 * @param {{ ignoreUsers: string[], ignoreLines: string[], emotes: string[] }} ctx.lists
 * @param {boolean|null} ctx.streamLive 配信中か（null は不明）
 * @param {Cooldown} ctx.cooldown
 * @param {number} ctx.coolDownCount
 * @returns {{ action: 'ignore', reason: string } | { action: 'command', list: string } | { action: 'translate', text: string, toLang: string }}
 */
function decide(event, ctx) {
    if (String(event.chatter_user_id) === String(ctx.botUserId)) {
        return { action: 'ignore', reason: 'self' };
    }

    if (event.source_broadcaster_user_id && String(event.source_broadcaster_user_id) !== String(ctx.broadcasterId)) {
        return { action: 'ignore', reason: 'shared_chat_other_channel' };
    }

    const line = String(event.message && event.message.text || '').trim();

    if (line === '') {
        return { action: 'ignore', reason: 'empty' };
    }

    if (matchesIgnoreLine(line, ctx.lists.ignoreLines)) {
        return { action: 'ignore', reason: 'ignore_line' };
    }

    if (Object.prototype.hasOwnProperty.call(COMMANDS, line)) {
        return isPrivileged(event, ctx.broadcasterId)
            ? { action: 'command', list: COMMANDS[line] }
            : { action: 'ignore', reason: 'command_not_permitted' };
    }

    if (line.startsWith('!')) {
        return { action: 'ignore', reason: 'command' };
    }

    const broadcaster = isBroadcaster(event, ctx.broadcasterId);

    if (!broadcaster && ctx.streamLive === false) {
        return { action: 'ignore', reason: 'offline' };
    }

    const login = String(event.chatter_user_login || '').toLowerCase();

    if ((ctx.lists.ignoreUsers || []).map((u) => String(u).toLowerCase()).indexOf(login) !== -1) {
        return { action: 'ignore', reason: 'ignore_user' };
    }

    if (!isPrivileged(event, ctx.broadcasterId) && ctx.cooldown.isSpamming(login, ctx.coolDownCount)) {
        return { action: 'ignore', reason: 'cooldown' };
    }

    const text = removeEmotes(event, ctx.lists.emotes);

    if (text === '') {
        return { action: 'ignore', reason: 'only_emotes' };
    }

    return { action: 'translate', text, toLang: JP_RE.test(text) ? 'en' : 'ja' };
}

module.exports = { decide, Cooldown, removeEmotes, isBroadcaster, isPrivileged, COMMANDS, JP_RE };
