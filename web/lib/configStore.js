'use strict';

const paths = require('../../lib/paths');
const { readJson, writeJsonAtomic, statSafe } = require('../../lib/fileStore');
const { CHANNEL_FIELDS, SHARED_FIELDS, validateField } = require('./configSchema');

/**
 * 設定の読み書き（複数チャンネル対応版）。
 *
 * - チャンネルの設定: channels/<login>/config/local.json の config セクション
 *   （twitchChannel・twitchBroadcasterId はシステムが管理し、ここでは編集させない）
 * - 共通の設定: config/local.json の config セクション（config/default.json は書き換えない）
 *   EventSub の 2 項目は config.eventsub.{callbackUrl, secret} に入れる（lib/sharedConfig.js と同じ形）
 */

function readSection(file) {
    const result = readJson(file);

    if (result.error) {
        throw new Error(file + ' を読み込めません。' + result.error);
    }

    const root = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : {};
    const section = root.config && typeof root.config === 'object' ? root.config : {};

    return { root, config: section };
}

function applyPatch(fields, current, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { errors: { _: '保存するデータが不正です。' } };
    }

    const byKey = new Map(fields.map((field) => [field.key, field]));
    const next = Object.assign({}, current);
    const errors = {};
    const saved = [];

    for (const key of Object.keys(patch)) {
        const field = byKey.get(key);

        if (!field) {
            errors[key] = '未知の設定項目です。';
            continue;
        }

        const raw = patch[key];
        const blank = raw === null || raw === undefined || String(raw).trim() === '';

        // secret 項目は空欄なら「変更しない」
        if (field.secret && blank) { continue; }

        if (blank && !field.required) {
            if (Object.prototype.hasOwnProperty.call(next, key)) {
                delete next[key];
                saved.push(key);
            }
            continue;
        }

        const result = validateField(field, raw);

        if (result.error) {
            errors[key] = result.error;
            continue;
        }

        next[key] = result.value;
        saved.push(key);
    }

    return Object.keys(errors).length > 0 ? { errors } : { next, saved };
}

// ------------------------------------------------------------------
// チャンネルの設定
// ------------------------------------------------------------------

function channelSnapshot(login) {
    const { config } = readSection(paths.channel(login).localConfig);
    const values = {};

    for (const field of CHANNEL_FIELDS) {
        const has = Object.prototype.hasOwnProperty.call(config, field.key);

        values[field.key] = { value: has ? config[field.key] : field.default, isDefault: !has };
    }

    return {
        values,
        twitchChannel: config.twitchChannel || login,
        twitchBroadcasterId: config.twitchBroadcasterId ? String(config.twitchBroadcasterId) : null
    };
}

function saveChannel(login, patch) {
    const file = paths.channel(login).localConfig;
    const { root, config } = readSection(file);
    const editable = {};

    for (const field of CHANNEL_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(config, field.key)) { editable[field.key] = config[field.key]; }
    }

    const result = applyPatch(CHANNEL_FIELDS, editable, patch);

    if (result.errors) { return { ok: false, errors: result.errors }; }

    // システムが管理する値（対象チャンネル・配信者の ID）は元の値を残す
    const next = Object.assign({}, config, result.next);

    for (const field of CHANNEL_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(result.next, field.key)) { delete next[field.key]; }
    }

    next.twitchChannel = login;
    writeJsonAtomic(file, Object.assign({}, root, { config: next }), { mode: 0o600 });

    return { ok: true, saved: result.saved };
}

/** 配信者の ID を記録する（登録済みの配信者がログインしたとき。ユーザーは編集できない） */
function setBroadcasterId(login, id) {
    const file = paths.channel(login).localConfig;
    const { root, config } = readSection(file);

    if (String(config.twitchBroadcasterId || '') === String(id)) { return false; }

    const next = Object.assign({}, config, { twitchChannel: login, twitchBroadcasterId: String(id) });

    writeJsonAtomic(file, Object.assign({}, root, { config: next }), { mode: 0o600 });

    return true;
}

// ------------------------------------------------------------------
// 共通の設定（運営者）
// ------------------------------------------------------------------

function flattenShared(config) {
    const eventsub = config.eventsub && typeof config.eventsub === 'object' ? config.eventsub : {};

    return {
        twitchClientId: config.twitchClientId,
        twitchClientSecret: config.twitchClientSecret,
        eventsubCallbackUrl: eventsub.callbackUrl,
        eventsubSecret: eventsub.secret
    };
}

function isUsable(value) {
    return typeof value === 'string' && value.trim() !== '' && !/[^\x20-\x7e]/.test(value);
}

function sharedSnapshot() {
    const base = flattenShared(readSection(paths.DEFAULT_CONFIG).config);
    const local = flattenShared(readSection(paths.LOCAL_CONFIG).config);
    const values = {};

    for (const field of SHARED_FIELDS) {
        const fromLocal = isUsable(local[field.key]);
        const value = fromLocal ? local[field.key] : (isUsable(base[field.key]) ? base[field.key] : null);

        values[field.key] = {
            value: field.secret ? null : value,
            hasValue: value !== null,
            source: value === null ? null : (fromLocal ? 'local.json' : 'default.json')
        };
    }

    return { values };
}

function saveShared(patch) {
    const { root, config } = readSection(paths.LOCAL_CONFIG);
    const current = {};
    const flat = flattenShared(config);

    for (const field of SHARED_FIELDS) {
        if (flat[field.key] !== undefined) { current[field.key] = flat[field.key]; }
    }

    const result = applyPatch(SHARED_FIELDS, current, patch);

    if (result.errors) { return { ok: false, errors: result.errors }; }

    const next = Object.assign({}, config, {
        twitchClientId: result.next.twitchClientId,
        twitchClientSecret: result.next.twitchClientSecret,
        eventsub: Object.assign({}, config.eventsub, {
            callbackUrl: result.next.eventsubCallbackUrl,
            secret: result.next.eventsubSecret
        })
    });

    for (const key of ['twitchClientId', 'twitchClientSecret']) {
        if (next[key] === undefined) { delete next[key]; }
    }
    for (const key of ['callbackUrl', 'secret']) {
        if (next.eventsub[key] === undefined) { delete next.eventsub[key]; }
    }

    writeJsonAtomic(paths.LOCAL_CONFIG, Object.assign({}, root, { config: next }), { mode: 0o600 });

    return { ok: true, saved: result.saved };
}

function relativePath(file) {
    return file.startsWith(paths.ROOT + '/') ? file.slice(paths.ROOT.length + 1) : file;
}

function meta(file) {
    const stat = statSafe(file);

    return { path: relativePath(file), exists: stat !== null, updatedAt: stat ? stat.mtime.toISOString() : null };
}

module.exports = {
    channelSnapshot, saveChannel, setBroadcasterId,
    sharedSnapshot, saveShared,
    relativePath, meta
};
