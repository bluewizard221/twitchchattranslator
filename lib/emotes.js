'use strict';

const REQUEST_TIMEOUT_MS = 15000;

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!res.ok) {
        const error = new Error('HTTP ' + res.status + ' ' + res.statusText);
        error.status = res.status;
        throw error;
    }

    return await res.json();
}

/** 個々の取得元が失敗しても全体は止めず、警告として記録する */
async function collect(result, source, label, loader) {
    try {
        const names = await loader();
        let added = 0;
        let skipped = 0;

        for (const name of names) {
            if (typeof name !== 'string') { continue; }

            const trimmed = name.trim();

            if (trimmed === '' || result.seen.has(trimmed)) { continue; }

            // 空白を含む名前は 1 語単位で除去する bot 側の処理と噛み合わないため除外する
            if (/\s/.test(trimmed)) {
                skipped++;
                continue;
            }

            result.seen.add(trimmed);
            result.names.push(trimmed);
            added++;
        }

        if (skipped > 0) {
            result.warnings.push(label + 'のうち、空白を含む ' + skipped + ' 件は登録できないため除外しました。');
        }

        result.sources.push({ source: source, label: label, count: names.length, added: added, ok: true });
    } catch (err) {
        const reason = err.status === 404
            ? '登録が見つかりませんでした（HTTP 404）'
            : (err.name === 'TimeoutError' ? 'タイムアウトしました' : err.message);

        result.sources.push({ source: source, label: label, count: 0, added: 0, ok: false, error: reason });
        result.warnings.push(label + 'の取得に失敗しました: ' + reason);
    }
}

/**
 * BetterTTV と FrankerFaceZ からエモート名を取得する。
 * @param {{ twitchChannel: string, twitchUserId: string|number }} options
 * @returns {Promise<{ names: string[], sources: object[], warnings: string[] }>}
 */
async function fetchEmoteNames(options) {
    const opts = options || {};
    const channel = String(opts.twitchChannel || '').trim().toLowerCase();
    const userId = String(opts.twitchUserId || '').trim();

    if (!channel) { throw new Error('チャンネル名が指定されていません。'); }
    if (!/^[a-zA-Z0-9_]{1,25}$/.test(channel)) { throw new Error('チャンネル名の形式が正しくありません: ' + channel); }
    if (userId && !/^[0-9]{1,20}$/.test(userId)) { throw new Error('ユーザー ID は数字で指定してください: ' + userId); }

    const result = { names: [], seen: new Set(), sources: [], warnings: [] };

    await collect(result, 'bttv-global', 'BTTV グローバルエモート', async () => {
        const data = await fetchJson('https://api.betterttv.net/3/cached/emotes/global');

        return Array.isArray(data) ? data.map((emote) => emote.code) : [];
    });

    if (userId) {
        await collect(result, 'bttv-channel', 'BTTV チャンネルエモート', async () => {
            const data = await fetchJson('https://api.betterttv.net/3/cached/users/twitch/' + encodeURIComponent(userId));
            const own = Array.isArray(data.channelEmotes) ? data.channelEmotes : [];
            const shared = Array.isArray(data.sharedEmotes) ? data.sharedEmotes : [];

            return own.concat(shared).map((emote) => emote.code);
        });
    } else {
        result.warnings.push('配信者のユーザー ID が未設定のため、BTTV チャンネルエモートは取得していません。');
    }

    await collect(result, 'ffz-room', 'FFZ チャンネルエモート', async () => {
        const data = await fetchJson('https://api.frankerfacez.com/v1/room/' + encodeURIComponent(channel));

        return emoteNamesFromFfzSets(data.sets, data.room ? [data.room.set] : []);
    });

    await collect(result, 'ffz-global', 'FFZ グローバルエモート', async () => {
        const data = await fetchJson('https://api.frankerfacez.com/v1/set/global');

        return emoteNamesFromFfzSets(data.sets, data.default_sets);
    });

    return { names: result.names, sources: result.sources, warnings: result.warnings };
}

function emoteNamesFromFfzSets(sets, setIds) {
    if (!sets || typeof sets !== 'object') { return []; }

    const ids = Array.isArray(setIds) ? setIds : [setIds];
    const names = [];

    for (const id of ids) {
        const set = sets[String(id)];

        if (!set || !Array.isArray(set.emoticons)) { continue; }

        for (const emote of set.emoticons) {
            if (emote && typeof emote.name === 'string') {
                names.push(emote.name);
            }
        }
    }

    return names;
}

module.exports = { fetchEmoteNames };
