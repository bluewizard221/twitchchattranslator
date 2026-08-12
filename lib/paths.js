'use strict';

const path = require('path');

// プロジェクトのルートディレクトリ（web/lib から 2 階層上）
// TCT_ROOT を指定すると別のディレクトリを対象にできる（テストや複数構成の運用向け）
const ROOT = process.env.TCT_ROOT
    ? path.resolve(process.env.TCT_ROOT)
    : path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(ROOT, 'config');

module.exports = {
    ROOT,
    CONFIG_DIR,

    // node-config が読み込む設定ファイル群
    DEFAULT_CONFIG: path.join(CONFIG_DIR, 'default.json'),
    LOCAL_CONFIG: path.join(CONFIG_DIR, 'local.json'),
    JSONUPDATE_CONFIG: path.join(CONFIG_DIR, 'jsonupdate.json'),
    WEBUI_CONFIG: path.join(CONFIG_DIR, 'webui.json'),

    // bot が参照するリストファイル群
    EMOTICONS: path.join(ROOT, 'emoticons.json'),
    IGNORE_USERS: path.join(ROOT, 'ignoreusers.json'),
    IGNORE_LINES: path.join(ROOT, 'ignoreline.json'),

    // Google Cloud サービスアカウントキーの既定の保存先
    DEFAULT_GOOGLE_KEY: path.join(CONFIG_DIR, 'google-key.json'),

    envConfig(env) {
        return path.join(CONFIG_DIR, env + '.json');
    }
};
