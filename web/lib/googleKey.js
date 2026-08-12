'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('../../lib/paths');
const { writeJsonAtomic, statSafe } = require('../../lib/fileStore');

const MAX_KEY_BYTES = 64 * 1024;

/**
 * アップロードされたサービスアカウントキーの中身を検証する。
 * @returns {{ ok: boolean, key?: object, error?: string, warnings: string[] }}
 */
function validateKeyContent(text) {
    const warnings = [];

    if (typeof text !== 'string' || text.trim() === '') {
        return { ok: false, error: 'ファイルの中身が空です。', warnings };
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_KEY_BYTES) {
        return { ok: false, error: 'ファイルサイズが大きすぎます（64KB 以内）。サービスアカウントキーではない可能性があります。', warnings };
    }

    let key;

    try {
        key = JSON.parse(text);
    } catch (err) {
        return { ok: false, error: 'JSON として解釈できませんでした。ダウンロードしたキーファイルをそのままアップロードしてください。', warnings };
    }

    if (!key || typeof key !== 'object' || Array.isArray(key)) {
        return { ok: false, error: 'JSON の形式が正しくありません。', warnings };
    }

    if (key.type !== 'service_account') {
        return {
            ok: false,
            error: 'サービスアカウントキーではないようです（"type" が "service_account" ではありません）。',
            warnings
        };
    }

    for (const required of ['project_id', 'client_email', 'private_key']) {
        if (typeof key[required] !== 'string' || key[required] === '') {
            return { ok: false, error: '必須項目 "' + required + '" が見つかりません。', warnings };
        }
    }

    if (key.private_key.indexOf('BEGIN PRIVATE KEY') === -1) {
        warnings.push('private_key の形式が一般的なものと異なります。正しいキーファイルか確認してください。');
    }

    return { ok: true, key: key, warnings: warnings };
}

/** 保存先のファイル名を config ディレクトリ配下に限定する */
function resolveDestination(fileName) {
    const fallback = paths.DEFAULT_GOOGLE_KEY;

    if (!fileName || typeof fileName !== 'string') { return fallback; }

    const base = path.basename(fileName.trim());

    if (base === '' || base === '.' || base === '..') { return fallback; }
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(base)) { return fallback; }
    if (!base.toLowerCase().endsWith('.json')) { return fallback; }

    return path.join(paths.CONFIG_DIR, base);
}

/**
 * サービスアカウントキーを保存する。
 * 既存のキーは <file>.bak に退避され、パーミッションは 0600 に設定される。
 */
function save(text, fileName) {
    const validated = validateKeyContent(text);

    if (!validated.ok) { return validated; }

    const destination = resolveDestination(fileName);

    writeJsonAtomic(destination, validated.key, { mode: 0o600 });

    return {
        ok: true,
        warnings: validated.warnings,
        projectId: validated.key.project_id,
        clientEmail: validated.key.client_email,
        path: relative(destination),
        absolutePath: destination
    };
}

/** 設定されているキーファイルの状態を調べる（秘密鍵そのものは返さない） */
function status(configuredPath) {
    const configured = typeof configuredPath === 'string' ? configuredPath.trim() : '';

    if (configured === '') {
        return { configured: null, exists: false, valid: false, message: 'キーファイルのパスが未設定です。' };
    }

    const absolute = path.isAbsolute(configured) ? configured : path.join(paths.ROOT, configured);
    const stat = statSafe(absolute);

    if (!stat || !stat.isFile()) {
        return {
            configured: configured,
            exists: false,
            valid: false,
            message: 'ファイルが見つかりません: ' + absolute
        };
    }

    let parsed = null;

    try {
        parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    } catch (err) {
        return {
            configured: configured,
            exists: true,
            valid: false,
            updatedAt: stat.mtime.toISOString(),
            message: 'ファイルを JSON として読み込めませんでした。'
        };
    }

    const valid = !!parsed && parsed.type === 'service_account' && !!parsed.client_email;

    return {
        configured: configured,
        exists: true,
        valid: valid,
        projectId: parsed && typeof parsed.project_id === 'string' ? parsed.project_id : null,
        clientEmail: parsed && typeof parsed.client_email === 'string' ? parsed.client_email : null,
        size: stat.size,
        mode: '0' + (stat.mode & 0o777).toString(8),
        updatedAt: stat.mtime.toISOString(),
        message: valid ? null : 'サービスアカウントキーの形式ではありません。'
    };
}

function relative(file) {
    return file.startsWith(paths.ROOT + '/') ? file.slice(paths.ROOT.length + 1) : file;
}

module.exports = { validateKeyContent, resolveDestination, save, status, MAX_KEY_BYTES };
