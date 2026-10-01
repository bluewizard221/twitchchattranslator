'use strict';

const fs = require('fs');
const paths = require('./paths');
const { readJson, writeJsonAtomic } = require('./fileStore');

/**
 * チャンネルの登録簿（仕様書 5 節）。
 * 登録済みかどうかは channels/<login>/channel.json の有無で判定する。
 */

// リストファイルの初期内容（bot が読む形式）
const EMPTY_LISTS = [
    ['ignoreUsers', { ignoreusers: [] }],
    ['ignoreLines', { ignorelines: [] }],
    ['emoticons', { emoticons: [] }]
];

function normalize(login) {
    return typeof login === 'string' ? login.trim().toLowerCase() : '';
}

/** 登録済みのチャンネルの情報。未登録・壊れている場合は null */
function get(login) {
    const name = normalize(login);

    if (!paths.isValidLogin(name)) { return null; }

    const result = readJson(paths.channel(name).meta);

    if (result.missing || result.error || !result.data || result.data.login !== name) {
        return null;
    }

    return result.data;
}

function exists(login) {
    return get(login) !== null;
}

/** 登録済みのチャンネルの一覧（ログイン名順） */
function list() {
    let entries;

    try {
        entries = fs.readdirSync(paths.CHANNELS_DIR, { withFileTypes: true });
    } catch (err) {
        if (err.code === 'ENOENT') { return []; }
        throw err;
    }

    return entries
        .filter((entry) => entry.isDirectory() && paths.isValidLogin(entry.name))
        .map((entry) => get(entry.name))
        .filter((meta) => meta !== null)
        .sort((a, b) => a.login.localeCompare(b.login));
}

/**
 * チャンネルを登録し、ディレクトリと初期ファイルを作る。
 * @returns {{ ok: true, channel: object } | { ok: false, error: string }}
 */
function create(login, options) {
    const name = normalize(login);
    const opts = options || {};

    if (!paths.isValidLogin(name)) {
        return { ok: false, error: 'Twitch のログイン名の形式が正しくありません（半角英小文字・数字・アンダースコア 3〜25 文字）。' };
    }
    if (fs.existsSync(paths.channel(name).root)) {
        return { ok: false, error: 'このチャンネルはすでに登録されています: ' + name };
    }

    const p = paths.channel(name);

    fs.mkdirSync(paths.CHANNELS_DIR, { recursive: true, mode: 0o750 });
    fs.mkdirSync(p.root, { mode: 0o750 });
    fs.mkdirSync(p.configDir, { mode: 0o700 });
    fs.mkdirSync(p.secretsDir, { mode: 0o700 });
    fs.mkdirSync(p.logDir, { mode: 0o750 });

    for (const [key, body] of EMPTY_LISTS) {
        writeJsonAtomic(p[key], body, { mode: 0o644, backup: false });
    }

    // 対象チャンネルはログイン名に固定する（仕様書 2 節）
    writeJsonAtomic(p.localConfig, { config: { twitchChannel: name } }, { mode: 0o600, backup: false });

    const meta = {
        login: name,
        createdAt: new Date().toISOString(),
        createdBy: opts.createdBy || null
    };

    writeJsonAtomic(p.meta, meta, { mode: 0o640, backup: false });

    return { ok: true, channel: meta };
}

/**
 * bot を動かすかどうか（管理画面の起動・停止で切り替える）。登録直後は true。
 * 実際に起動するかは、これに加えて準備がそろっているか（lib/readiness.js）で決まる。
 */
function isEnabled(login) {
    const meta = get(login);

    return meta !== null && meta.enabled !== false;
}

function setEnabled(login, enabled) {
    const meta = get(login);

    if (!meta) { return false; }

    meta.enabled = !!enabled;
    writeJsonAtomic(paths.channel(meta.login).meta, meta, { mode: 0o640, backup: false });

    return true;
}

/**
 * チャンネルのディレクトリを丸ごと削除する（秘密の値・設定・リスト・ログ）。
 * トークンの無効化や購読の削除は呼び出し側（削除の手順全体）で先に行うこと。
 * @returns {boolean} 削除したかどうか
 */
function removeFiles(login) {
    const name = normalize(login);

    if (!paths.isValidLogin(name)) { return false; }

    const root = paths.channel(name).root;

    if (!fs.existsSync(root)) { return false; }

    fs.rmSync(root, { recursive: true, force: true });

    return true;
}

module.exports = { get, exists, list, create, removeFiles, normalize, isEnabled, setEnabled };
