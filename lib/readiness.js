'use strict';

const fs = require('fs');
const paths = require('./paths');
const channels = require('./channels');

/**
 * チャンネルの bot を起動できる状態かどうか（仕様書 6 節の利用開始の流れ）。
 * そろっていないチャンネルは起動しない（何度も異常終了と再起動を繰り返さないため）。
 * @returns {{ ready: boolean, missing: { key: string, label: string }[] }}
 */
function checkChannel(login) {
    if (!channels.exists(login)) {
        return { ready: false, missing: [{ key: 'registered', label: 'チャンネルの登録' }] };
    }

    const p = paths.channel(login);
    const missing = [];

    if (!fs.existsSync(p.botTokens)) {
        missing.push({ key: 'botTokens', label: 'bot アカウントの接続' });
    }
    if (!fs.existsSync(p.googleKey)) {
        missing.push({ key: 'googleKey', label: 'Google Cloud のキー' });
    }

    return { ready: missing.length === 0, missing };
}

module.exports = { checkChannel };
