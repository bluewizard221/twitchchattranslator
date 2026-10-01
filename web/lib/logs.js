'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('../../lib/paths');

/** 管理画面から閲覧できるログ。ここにないファイルは読ませない */
const LOGS = [
    { id: 'bot', label: '翻訳 bot', file: 'twitchchattranslator.log' },
    { id: 'webui', label: '管理画面', file: 'webui.log' },
    { id: 'emotes', label: 'エモート自動更新', file: 'emotelistupdate.log' }
];

// 末尾からこのバイト数だけ読む（日次ローテーションなので通常はファイル全体が収まる）
const MAX_READ_BYTES = 512 * 1024;
const DEFAULT_LINES = 200;
const MAX_LINES = 2000;
const PROBLEM_RE = /\[(WARN|ERROR|FATAL)\]/;

function find(id) {
    return LOGS.find((def) => def.id === id) || null;
}

function filePath(def) {
    return path.join(paths.LOG_DIR, def.file);
}

function relative(def) {
    return 'logs/' + def.file;
}

/** ログ一覧（存在するか・サイズ・最終更新） */
function describeAll() {
    return LOGS.map((def) => {
        let stat = null;

        try {
            stat = fs.statSync(filePath(def));
        } catch (err) {
            // 未作成
        }

        return {
            id: def.id,
            label: def.label,
            path: relative(def),
            exists: !!stat,
            size: stat ? stat.size : 0,
            updatedAt: stat ? stat.mtime.toISOString() : null
        };
    });
}

function toLineCount(raw) {
    const num = Number(raw);

    if (!Number.isInteger(num) || num < 1) { return DEFAULT_LINES; }

    return Math.min(num, MAX_LINES);
}

/** 念のため、トークンらしき文字列は伏せて返す */
function mask(line) {
    return line
        .replace(/oauth:[A-Za-z0-9]+/gi, 'oauth:***')
        .replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, '$1***')
        .replace(/((?:access|refresh)_?token["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi, '$1***');
}

/**
 * ログの末尾を返す。
 * @param {string} id      LOGS の id
 * @param {{ lines?: number|string, level?: string }} options  level === 'warn' で WARN/ERROR のみ
 * @returns {object|null}  未知の id なら null
 */
function tail(id, options) {
    const def = find(id);

    if (!def) { return null; }

    const opts = options || {};
    const maxLines = toLineCount(opts.lines);
    const problemsOnly = opts.level === 'warn';
    const base = { id: def.id, label: def.label, path: relative(def), problemsOnly: problemsOnly };

    let stat;

    try {
        stat = fs.statSync(filePath(def));
    } catch (err) {
        return Object.assign(base, {
            exists: false,
            lines: [],
            error: err.code === 'ENOENT' ? 'ログファイルはまだありません。' : 'ログファイルを読めません: ' + err.message
        });
    }

    const start = Math.max(0, stat.size - MAX_READ_BYTES);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath(def), 'r');

    try {
        fs.readSync(fd, buffer, 0, length, start);
    } finally {
        fs.closeSync(fd);
    }

    let lines = buffer.toString('utf8').split('\n');

    // 途中から読んだ場合、先頭の行は欠けているので捨てる
    if (start > 0) { lines.shift(); }
    if (lines.length && lines[lines.length - 1] === '') { lines.pop(); }

    if (problemsOnly) {
        lines = lines.filter((line) => PROBLEM_RE.test(line));
    }

    return Object.assign(base, {
        exists: true,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        truncated: start > 0,
        matched: lines.length,
        lines: lines.slice(-maxLines).map(mask)
    });
}

module.exports = { LOGS, describeAll, tail, DEFAULT_LINES, MAX_LINES };
