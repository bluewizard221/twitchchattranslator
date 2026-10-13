'use strict';

const paths = require('../../lib/paths');
const { readJson } = require('../../lib/fileStore');

/**
 * 運営者の Twitch ログイン名の一覧（D13）。
 * 読み込み元: config/operators.json の operators、環境変数 WEBUI_OPERATORS、
 * 旧形式の config/webui.json の allowedUsers（互換のため運営者として扱う）。
 * 呼び出しのたびにファイルを読み直す（変更をすぐに反映するため）。
 */
function loadOperators(legacyAllowedUsers) {
    const result = readJson(paths.OPERATORS);
    const fromFile = result.data && Array.isArray(result.data.operators) ? result.data.operators : [];
    const fromEnv = (process.env.WEBUI_OPERATORS || '').split(/[,\s]+/);
    const legacy = Array.isArray(legacyAllowedUsers) ? legacyAllowedUsers : [];

    return Array.from(new Set(
        fromFile.concat(fromEnv, legacy)
            .map((name) => String(name).trim().toLowerCase())
            .filter((name) => paths.isValidLogin(name))
    ));
}

module.exports = { loadOperators };
