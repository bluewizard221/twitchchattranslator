'use strict';

const paths = require('./paths');
const { readJson, writeJsonAtomic, statSafe } = require('./fileStore');

/**
 * bot が参照する 3 つのリストファイルの定義。
 * ファイルパスはこの表（またはチャンネルのパス）からしか解決しないため、外部からの任意パス指定は成立しない。
 */
const LISTS = {
    ignoreusers: {
        id: 'ignoreusers',
        label: '翻訳しないユーザー',
        file: paths.IGNORE_USERS,
        channelKey: 'ignoreUsers',
        rootKey: 'ignoreusers',
        help: 'ここに書いたユーザーの発言は翻訳しません。他の bot などを登録します（1 行に 1 ユーザー）。',
        placeholder: 'nightbot',
        validate: validateUserName
    },
    ignoreline: {
        id: 'ignoreline',
        label: '翻訳しない文字列（正規表現）',
        file: paths.IGNORE_LINES,
        channelKey: 'ignoreLines',
        rootKey: 'ignorelines',
        help: '正規表現にマッチした発言は翻訳しません（1 行に 1 パターン）。URL の除外などに利用します。',
        placeholder: '(ttp|ttps)\\://[a-zA-Z0-9]+',
        validate: validateRegex
    },
    emoticons: {
        id: 'emoticons',
        label: 'エモート一覧',
        file: paths.EMOTICONS,
        channelKey: 'emoticons',
        rootKey: 'emoticons',
        help: 'ここに登録された文字列は翻訳前に取り除かれます（1 行に 1 エモート）。BTTV / FFZ から自動取得もできます。',
        placeholder: 'FeelsGoodMan',
        validate: validateEmote
    }
};

function validateUserName(value) {
    if (!/^[a-zA-Z0-9_]{1,25}$/.test(value)) {
        return 'ユーザー名は半角英数字とアンダースコア 25 文字以内で入力してください: ' + value;
    }
    return null;
}

function validateRegex(value) {
    try {
        new RegExp(value);
    } catch (err) {
        return '正規表現として解釈できません: ' + value + '（' + err.message + '）';
    }
    return null;
}

function validateEmote(value) {
    if (/\s/.test(value)) {
        return 'エモート名に空白は含められません: ' + value;
    }
    return null;
}

function getList(id) {
    return Object.prototype.hasOwnProperty.call(LISTS, id) ? LISTS[id] : null;
}

/** 読み書きするファイル。チャンネルを指定した場合は channels/<login>/ の下 */
function fileOf(def, channelPaths) {
    return channelPaths ? channelPaths[def.channelKey] : def.file;
}

function read(id, channelPaths) {
    const def = getList(id);

    if (!def) { throw new Error('不明なリストです: ' + id); }

    const file = fileOf(def, channelPaths);
    const result = readJson(file);

    if (result.error) {
        return { id: id, items: [], error: file + ' を読み込めません。' + result.error, updatedAt: null };
    }
    if (result.missing) {
        return { id: id, items: [], error: null, updatedAt: null };
    }

    const raw = result.data ? result.data[def.rootKey] : null;

    if (!Array.isArray(raw)) {
        return {
            id: id,
            items: [],
            error: 'ファイルの形式が想定と異なります（"' + def.rootKey + '" 配列が見つかりません）。',
            updatedAt: null
        };
    }

    const stat = statSafe(file);

    return {
        id: id,
        items: raw.map((item) => String(item)),
        error: null,
        updatedAt: stat ? stat.mtime.toISOString() : null
    };
}

/**
 * リストを検証して保存する。空行・重複は取り除く。
 * @returns {{ ok: boolean, items?: string[], removedDuplicates?: number, errors?: string[] }}
 */
function write(id, items, channelPaths) {
    const def = getList(id);

    if (!def) { throw new Error('不明なリストです: ' + id); }

    if (!Array.isArray(items)) {
        return { ok: false, errors: ['リストは配列で送信してください。'] };
    }
    if (items.length > 20000) {
        return { ok: false, errors: ['項目が多すぎます（20000 件以内）。'] };
    }

    const errors = [];
    const seen = new Set();
    const cleaned = [];
    let duplicates = 0;

    for (const item of items) {
        if (typeof item !== 'string') {
            errors.push('文字列以外の項目が含まれています。');
            continue;
        }

        const value = item.trim();

        if (value === '') { continue; }

        if (value.length > 500) {
            errors.push('1 項目が長すぎます（500 文字以内）: ' + value.slice(0, 40) + '…');
            continue;
        }

        if (seen.has(value)) {
            duplicates++;
            continue;
        }

        const error = def.validate ? def.validate(value) : null;

        if (error) {
            errors.push(error);
            continue;
        }

        seen.add(value);
        cleaned.push(value);
    }

    if (errors.length > 0) {
        return { ok: false, errors: errors.slice(0, 20) };
    }

    const body = {};
    body[def.rootKey] = cleaned;

    // bot と同じディレクトリに置かれる公開ファイルなので 0644 で書き出す
    writeJsonAtomic(fileOf(def, channelPaths), body, { mode: 0o644 });

    return { ok: true, items: cleaned, removedDuplicates: duplicates };
}

function describeAll(channelPaths) {
    return Object.keys(LISTS).map((id) => ({
        id: id,
        label: LISTS[id].label,
        help: LISTS[id].help,
        placeholder: LISTS[id].placeholder,
        path: fileOf(LISTS[id], channelPaths)
    }));
}

/** チャンネルを指定したリスト操作（channels/<login>/ の下のファイルを読み書きする） */
function forChannel(login) {
    const channelPaths = paths.channel(login);

    return {
        getList,
        read: (id) => read(id, channelPaths),
        write: (id, items) => write(id, items, channelPaths),
        describeAll: () => describeAll(channelPaths)
    };
}

module.exports = { LISTS, getList, read, write, describeAll, forChannel };
