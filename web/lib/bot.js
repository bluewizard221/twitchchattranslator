'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('../../lib/paths');

/** pidFile に書かれたプロセス ID を読み取る */
function readPid(pidFile) {
    const configured = typeof pidFile === 'string' ? pidFile.trim() : '';

    if (configured === '') {
        return { ok: false, error: 'PID ファイルのパスが設定されていません。' };
    }

    const absolute = path.isAbsolute(configured) ? configured : path.join(paths.ROOT, configured);

    let raw;

    try {
        raw = fs.readFileSync(absolute, 'utf8');
    } catch (err) {
        return {
            ok: false,
            path: absolute,
            error: err.code === 'ENOENT'
                ? 'PID ファイルが見つかりません（bot が起動していない可能性があります）。'
                : 'PID ファイルを読み込めません: ' + err.message
        };
    }

    const pid = Number(raw.trim());

    if (!Number.isInteger(pid) || pid <= 1) {
        return { ok: false, path: absolute, error: 'PID ファイルの内容が不正です: ' + raw.trim().slice(0, 40) };
    }

    return { ok: true, pid: pid, path: absolute };
}

/** bot プロセスが生きているかを調べる */
function status(pidFile) {
    const result = readPid(pidFile);

    if (!result.ok) {
        return { running: false, pid: null, path: result.path || null, message: result.error };
    }

    try {
        process.kill(result.pid, 0);
        return { running: true, pid: result.pid, path: result.path, message: null };
    } catch (err) {
        if (err.code === 'EPERM') {
            // プロセスは存在するがシグナルを送る権限がない
            return {
                running: true,
                pid: result.pid,
                path: result.path,
                message: 'プロセスは存在しますが、この実行ユーザーからはシグナルを送れません。'
            };
        }

        return {
            running: false,
            pid: result.pid,
            path: result.path,
            message: 'PID ' + result.pid + ' のプロセスは動作していません。'
        };
    }
}

/**
 * bot に SIGHUP を送り、リストファイルを再読み込みさせる。
 * （twitchchattranslator.js は SIGHUP で ignoreusers / ignoreline / emoticons を読み直す）
 */
function reload(pidFile) {
    const result = readPid(pidFile);

    if (!result.ok) {
        return { ok: false, error: result.error };
    }

    try {
        process.kill(result.pid, 'SIGHUP');
        return { ok: true, pid: result.pid, message: 'PID ' + result.pid + ' に SIGHUP を送信しました。' };
    } catch (err) {
        if (err.code === 'ESRCH') {
            return { ok: false, error: 'PID ' + result.pid + ' のプロセスが見つかりません。bot が停止している可能性があります。' };
        }
        if (err.code === 'EPERM') {
            return { ok: false, error: 'PID ' + result.pid + ' にシグナルを送る権限がありません。' };
        }

        return { ok: false, error: 'シグナルの送信に失敗しました: ' + err.message };
    }
}

module.exports = { readPid, status, reload };
