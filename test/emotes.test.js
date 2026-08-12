'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { fetchEmoteNames } = require('../lib/emotes');

/** URL ごとに応答を差し替える fetch のスタブ */
function stubFetch(routes) {
    globalThis.fetch = async (url) => {
        for (const prefix of Object.keys(routes)) {
            if (String(url).startsWith(prefix)) {
                const route = routes[prefix];

                if (route.status && route.status >= 400) {
                    return { ok: false, status: route.status, statusText: 'Error', json: async () => ({}) };
                }

                return { ok: true, status: 200, json: async () => route.body };
            }
        }

        throw new Error('想定外のリクエスト: ' + url);
    };
}

const ROUTES = {
    'https://api.betterttv.net/3/cached/emotes/global': { body: [{ code: 'GlobalOne' }, { code: 'GlobalTwo' }] },
    'https://api.betterttv.net/3/cached/users/twitch/': {
        body: { channelEmotes: [{ code: 'ChannelOne' }], sharedEmotes: [{ code: 'SharedOne' }] }
    },
    'https://api.frankerfacez.com/v1/room/': {
        body: { room: { set: 100 }, sets: { 100: { emoticons: [{ name: 'RoomOne' }] } } }
    },
    'https://api.frankerfacez.com/v1/set/global': {
        body: { default_sets: [3, 4], sets: { 3: { emoticons: [{ name: 'FfzGlobalOne' }] }, 4: { emoticons: [{ name: 'FfzGlobalTwo' }] } } }
    }
};

test('4 つの取得元をまとめて重複を除く', async () => {
    stubFetch(ROUTES);

    const result = await fetchEmoteNames({ twitchChannel: 'my_channel', twitchUserId: '12345' });

    assert.deepStrictEqual(result.names.sort(), [
        'ChannelOne', 'FfzGlobalOne', 'FfzGlobalTwo', 'GlobalOne', 'GlobalTwo', 'RoomOne', 'SharedOne'
    ]);
    assert.strictEqual(result.warnings.length, 0);
    assert.strictEqual(result.sources.length, 4);
});

test('FFZ の default_sets が複数あってもすべて読み込む', async () => {
    stubFetch(ROUTES);

    const result = await fetchEmoteNames({ twitchChannel: 'my_channel', twitchUserId: '12345' });

    assert.ok(result.names.indexOf('FfzGlobalTwo') !== -1);
});

test('一部の取得元が失敗しても残りは取得する', async () => {
    stubFetch(Object.assign({}, ROUTES, {
        'https://api.frankerfacez.com/v1/room/': { status: 404 }
    }));

    const result = await fetchEmoteNames({ twitchChannel: 'my_channel', twitchUserId: '12345' });

    assert.ok(result.names.indexOf('GlobalOne') !== -1);
    assert.strictEqual(result.names.indexOf('RoomOne'), -1);
    assert.strictEqual(result.warnings.length, 1);
    assert.strictEqual(result.sources.filter((source) => !source.ok).length, 1);
});

test('ユーザー ID がない場合は BTTV チャンネルエモートを取得せず警告する', async () => {
    stubFetch(ROUTES);

    const result = await fetchEmoteNames({ twitchChannel: 'my_channel' });

    assert.strictEqual(result.names.indexOf('ChannelOne'), -1);
    assert.ok(result.warnings[0].indexOf('ユーザー ID') !== -1);
});

test('空白を含むエモート名は除外する', async () => {
    stubFetch(Object.assign({}, ROUTES, {
        'https://api.betterttv.net/3/cached/emotes/global': { body: [{ code: 'Fine' }, { code: 'not valid' }] }
    }));

    const result = await fetchEmoteNames({ twitchChannel: 'my_channel', twitchUserId: '12345' });

    assert.strictEqual(result.names.indexOf('not valid'), -1);
    assert.ok(result.warnings.some((warning) => warning.indexOf('空白') !== -1));
});

test('不正なチャンネル名は例外になる', async () => {
    stubFetch(ROUTES);

    await assert.rejects(() => fetchEmoteNames({ twitchChannel: 'bad channel/../x' }), /チャンネル名/);
    await assert.rejects(() => fetchEmoteNames({ twitchChannel: 'ok', twitchUserId: 'abc' }), /ユーザー ID/);
});
