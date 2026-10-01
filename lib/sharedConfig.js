'use strict';

const paths = require('./paths');
const { readJson } = require('./fileStore');

/**
 * 共通の設定（運営者の Twitch アプリと EventSub。仕様書 5 節）。
 * config/default.json → config/local.json の順に重ね、環境変数で上書きできる。
 * 値が説明文のまま（非 ASCII を含む）の項目は未設定として扱う。
 */
function usable(value) {
    return typeof value === 'string' && value.trim() !== '' && !/[^\x20-\x7e]/.test(value) ? value.trim() : '';
}

function load() {
    const merged = {};

    for (const file of [paths.DEFAULT_CONFIG, paths.LOCAL_CONFIG]) {
        const result = readJson(file);
        const section = result.data && result.data.config && typeof result.data.config === 'object' ? result.data.config : {};

        Object.assign(merged, section);
    }

    const eventsub = merged.eventsub && typeof merged.eventsub === 'object' ? merged.eventsub : {};

    return {
        twitchClientId: usable(process.env.TWITCH_CLIENT_ID || merged.twitchClientId),
        twitchClientSecret: usable(process.env.TWITCH_CLIENT_SECRET || merged.twitchClientSecret),
        eventsubCallbackUrl: usable(process.env.EVENTSUB_CALLBACK_URL || eventsub.callbackUrl),
        eventsubSecret: usable(process.env.EVENTSUB_SECRET || eventsub.secret)
    };
}

module.exports = { load };
