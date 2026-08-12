'use strict';

const fs = require('fs');
const path = require('path');

/**
 * JSON ファイルを読み込む。
 * 存在しない場合は { missing: true }、壊れている場合は { error } を返す。
 */
function readJson(file) {
    let raw;

    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            return { missing: true, data: null, error: null };
        }
        return { missing: false, data: null, error: err.message };
    }

    try {
        return { missing: false, data: JSON.parse(raw), error: null };
    } catch (err) {
        return { missing: false, data: null, error: 'JSON として解釈できません: ' + err.message };
    }
}

/**
 * JSON ファイルを不可分に書き込む。
 * 一時ファイルへ書いてから rename するため、書き込み途中のファイルを bot が読むことはない。
 * 既存ファイルは <file>.bak として 1 世代だけ退避する。
 */
function writeJsonAtomic(file, data, options) {
    const opts = options || {};
    const mode = opts.mode === undefined ? 0o600 : opts.mode;
    const body = JSON.stringify(data, null, opts.indent === undefined ? 2 : opts.indent) + '\n';

    fs.mkdirSync(path.dirname(file), { recursive: true });

    if (opts.backup !== false && fs.existsSync(file)) {
        try {
            fs.copyFileSync(file, file + '.bak');
        } catch (err) {
            // バックアップに失敗しても本体の書き込みは続行する
        }
    }

    const tmp = file + '.tmp-' + process.pid;

    try {
        fs.writeFileSync(tmp, body, { mode: mode });
        fs.renameSync(tmp, file);
    } catch (err) {
        try {
            fs.unlinkSync(tmp);
        } catch (ignored) {
            // 一時ファイルが残っていなければ何もしない
        }
        throw err;
    }

    // 既存ファイルを上書きした場合 rename ではパーミッションが引き継がれないことがある
    if (mode !== null) {
        try {
            fs.chmodSync(file, mode);
        } catch (ignored) {
            // Windows など chmod が効かない環境は無視する
        }
    }

    return body.length;
}

function statSafe(file) {
    try {
        return fs.statSync(file);
    } catch (err) {
        return null;
    }
}

module.exports = { readJson, writeJsonAtomic, statSafe };
