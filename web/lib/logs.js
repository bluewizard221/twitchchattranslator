'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('../../lib/paths');

/**
 * 管理画面から閲覧できるログ（複数チャンネル対応版）。ここにないファイルは読ませない。
 *
 * - チャンネルのログ: channels/<login>/logs/ の bot のログ（配信者は自分のチャンネルだけ、運営者はすべて）
 * - システムのログ: logs/ の管理プロセスと管理画面のログ（運営者だけ）
 */
const CHANNEL_LOGS = [
    { id: 'bot', label: '翻訳 bot', file: 'twitchchattranslator.log' }
];

const SYSTEM_LOGS = [
    { id: 'manager', label: '管理プロセス', file: 'manager.log' },
    { id: 'webui', label: '管理画面', file: 'webui.log' }
];

// 末尾からこのバイト数だけ読む（日次ローテーションなので通常はファイル全体が収まる）
const MAX_READ_BYTES = 512 * 1024;
const DEFAULT_LINES = 200;
const MAX_LINES = 2000;
const PROBLEM_RE = /\[(WARN|ERROR|FATAL)\]/;

function resolve(scope, id) {
    if (scope && scope.type === 'channel') {
        const def = CHANNEL_LOGS.find((d) => d.id === id);

        return def ? { def, dir: paths.channel(scope.login).logDir, rel: 'channels/' + scope.login + '/logs/' + def.file } : null;
    }
    if (scope && scope.type === 'system') {
        const def = SYSTEM_LOGS.find((d) => d.id === id);

        return def ? { def, dir: paths.LOG_DIR, rel: 'logs/' + def.file } : null;
    }
    return null;
}

/** ログ一覧（存在するか・サイズ・最終更新） */
function describe(scope) {
    const defs = scope.type === 'system' ? SYSTEM_LOGS : CHANNEL_LOGS;

    return defs.map((def) => {
        const target = resolve(scope, def.id);
        let stat = null;

        try {
            stat = fs.statSync(path.join(target.dir, def.file));
        } catch (err) {
            // 未作成
        }

        return { id: def.id, label: def.label, path: target.rel, exists: !!stat, size: stat ? stat.size : 0, updatedAt: stat ? stat.mtime.toISOString() : null };
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
 * @param {{ type: 'channel', login: string } | { type: 'system' }} scope
 * @param {string} id
 * @param {{ lines?: number|string, level?: string }} options  level === 'warn' で WARN/ERROR のみ
 * @returns {object|null} 未知の id なら null
 */
function tail(scope, id, options) {
    const target = resolve(scope, id);

    if (!target) { return null; }

    const opts = options || {};
    const maxLines = toLineCount(opts.lines);
    const problemsOnly = opts.level === 'warn';
    const file = path.join(target.dir, target.def.file);
    const base = { id: target.def.id, label: target.def.label, path: target.rel, problemsOnly };

    let stat;

    try {
        stat = fs.statSync(file);
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
    const fd = fs.openSync(file, 'r');

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

module.exports = { CHANNEL_LOGS, SYSTEM_LOGS, describe, tail, DEFAULT_LINES, MAX_LINES };
