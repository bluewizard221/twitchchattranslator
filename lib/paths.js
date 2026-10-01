'use strict';

const path = require('path');

// プロジェクトのルートディレクトリ（lib/ から 1 階層上）
// TCT_ROOT を指定すると別のディレクトリを対象にできる（テストや複数構成の運用向け）
const ROOT = process.env.TCT_ROOT
    ? path.resolve(process.env.TCT_ROOT)
    : path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const DATA_DIR = path.join(ROOT, 'data');
const CHANNELS_DIR = path.join(ROOT, 'channels');

// Twitch のログイン名（小文字の英数字とアンダースコア）。ディレクトリ名に使うので厳密に検証する
const LOGIN_RE = /^[a-z0-9_]{3,25}$/;

function isValidLogin(login) {
    return typeof login === 'string' && LOGIN_RE.test(login);
}

/**
 * チャンネルごとのファイルの場所（仕様書 5 節）。
 * login は呼び出し側で検証済みでも、ここでもう一度検証してから組み立てる（パスの組み立てに使うため）。
 */
function channel(login) {
    if (!isValidLogin(login)) {
        throw new Error('チャンネル名の形式が正しくありません: ' + login);
    }

    const root = path.join(CHANNELS_DIR, login);
    const configDir = path.join(root, 'config');
    const secretsDir = path.join(root, 'secrets');

    return {
        login,
        root,
        meta: path.join(root, 'channel.json'),
        configDir,
        localConfig: path.join(configDir, 'local.json'),
        secretsDir,
        botTokens: path.join(secretsDir, 'bot-tokens.json'),
        googleKey: path.join(secretsDir, 'google-key.json'),
        ignoreUsers: path.join(root, 'ignoreusers.json'),
        ignoreLines: path.join(root, 'ignoreline.json'),
        emoticons: path.join(root, 'emoticons.json'),
        logDir: path.join(root, 'logs'),
        pidFile: path.join(root, 'twitchchattranslator.pid')
    };
}

module.exports = {
    ROOT,
    CONFIG_DIR,
    DATA_DIR,
    CHANNELS_DIR,

    // 運営者の一覧と、管理プロセス・管理画面が使う共通のデータ
    OPERATORS: path.join(CONFIG_DIR, 'operators.json'),
    AUDIT_LOG: path.join(DATA_DIR, 'audit.log'),
    USAGE_DIR: path.join(DATA_DIR, 'usage'),

    isValidLogin,
    channel,

    // node-config が読み込む設定ファイル群
    DEFAULT_CONFIG: path.join(CONFIG_DIR, 'default.json'),
    LOCAL_CONFIG: path.join(CONFIG_DIR, 'local.json'),
    JSONUPDATE_CONFIG: path.join(CONFIG_DIR, 'jsonupdate.json'),
    WEBUI_CONFIG: path.join(CONFIG_DIR, 'webui.json'),

    // bot が参照するリストファイル群
    EMOTICONS: path.join(ROOT, 'emoticons.json'),
    IGNORE_USERS: path.join(ROOT, 'ignoreusers.json'),
    IGNORE_LINES: path.join(ROOT, 'ignoreline.json'),

    // bot・管理画面・エモート更新のログ（log4js の dateFile。当日分が *.log、過去分は *.log.YYYYMMDD.gz）
    LOG_DIR: path.join(ROOT, 'logs'),

    // Google Cloud サービスアカウントキーの既定の保存先
    DEFAULT_GOOGLE_KEY: path.join(CONFIG_DIR, 'google-key.json'),

    envConfig(env) {
        return path.join(CONFIG_DIR, env + '.json');
    }
};
