'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

/**
 * 操作の記録（仕様書 10 節。1 年保存: D19）。
 * data/audit.log に 1 行 1 件の JSON で追記する。秘密の値は書かない（呼び出し側で detail に入れないこと）。
 *
 *   { at, actor, action, channel, detail }
 */

const RETENTION_DAYS = 365;

function append(entry) {
    const line = JSON.stringify({
        at: new Date().toISOString(),
        actor: entry.actor || null,
        action: entry.action,
        channel: entry.channel || null,
        detail: entry.detail || null
    }) + '\n';

    fs.mkdirSync(path.dirname(paths.AUDIT_LOG), { recursive: true, mode: 0o750 });
    fs.appendFileSync(paths.AUDIT_LOG, line, { mode: 0o640 });
}

function readAll() {
    let text;

    try {
        text = fs.readFileSync(paths.AUDIT_LOG, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') { return []; }
        throw err;
    }

    return text.split('\n').filter((line) => line !== '').map((line) => {
        try {
            return JSON.parse(line);
        } catch (err) {
            return null;
        }
    }).filter((entry) => entry !== null);
}

/**
 * 新しい順に返す。
 * @param {{ channel?: string, limit?: number }} options channel を指定するとそのチャンネルの記録だけ
 */
function read(options) {
    const opts = options || {};
    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 2000);
    let entries = readAll();

    if (opts.channel) {
        entries = entries.filter((entry) => entry.channel === opts.channel);
    }

    return entries.reverse().slice(0, limit);
}

/** 保存期間を過ぎた記録を捨てる（ファイルを書き直す） */
function prune(days, now) {
    const limit = (now || Date.now()) - (days || RETENTION_DAYS) * 24 * 60 * 60 * 1000;
    const entries = readAll();
    const kept = entries.filter((entry) => Date.parse(entry.at) >= limit);

    if (kept.length === entries.length) { return 0; }

    const tmp = paths.AUDIT_LOG + '.tmp-' + process.pid;

    fs.writeFileSync(tmp, kept.map((entry) => JSON.stringify(entry) + '\n').join(''), { mode: 0o640 });
    fs.renameSync(tmp, paths.AUDIT_LOG);

    return entries.length - kept.length;
}

module.exports = { append, read, prune, RETENTION_DAYS };
