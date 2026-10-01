'use strict';

const fs = require('fs');
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

/**
 * チャンネルのサービスアカウントキーを保存する（channels/<login>/secrets/google-key.json、0600）。
 * 保存先はチャンネルごとに固定で、ファイル名は指定させない。古いキーの退避（.bak）も残さない（D11）。
 */
function saveForChannel(login, text) {
    const validated = validateKeyContent(text);

    if (!validated.ok) { return validated; }

    writeJsonAtomic(paths.channel(login).googleKey, validated.key, { mode: 0o600, backup: false });

    return {
        ok: true,
        warnings: validated.warnings,
        projectId: validated.key.project_id,
        clientEmail: validated.key.client_email
    };
}

/** チャンネルのキーの状態（秘密鍵そのものは返さない） */
function statusForChannel(login) {
    const file = paths.channel(login).googleKey;
    const stat = statSafe(file);

    if (!stat || !stat.isFile()) {
        return { exists: false, valid: false, message: 'Google Cloud のキーがまだアップロードされていません。' };
    }

    let parsed = null;

    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        return { exists: true, valid: false, updatedAt: stat.mtime.toISOString(), message: 'キーを JSON として読み込めませんでした。' };
    }

    const valid = !!parsed && parsed.type === 'service_account' && !!parsed.client_email;

    return {
        exists: true,
        valid,
        projectId: parsed && typeof parsed.project_id === 'string' ? parsed.project_id : null,
        clientEmail: parsed && typeof parsed.client_email === 'string' ? parsed.client_email : null,
        mode: '0' + (stat.mode & 0o777).toString(8),
        updatedAt: stat.mtime.toISOString(),
        message: valid ? null : 'サービスアカウントキーの形式ではありません。'
    };
}

/** チャンネルのキーを削除する。GCP 側ではキーは有効なままなので、配信者に GCP のコンソールでの削除を案内すること */
function removeForChannel(login) {
    const file = paths.channel(login).googleKey;

    if (!fs.existsSync(file)) { return false; }

    fs.unlinkSync(file);

    return true;
}

module.exports = { validateKeyContent, saveForChannel, statusForChannel, removeForChannel, MAX_KEY_BYTES };
