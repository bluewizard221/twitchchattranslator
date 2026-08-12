'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * テスト用の一時プロジェクトディレクトリを作り、TCT_ROOT に設定する。
 * web/lib/paths.js を require する前に呼ぶこと。
 */
function useTempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tct-test-'));

    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    process.env.TCT_ROOT = root;

    process.on('exit', () => {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch (err) {
            // 後始末に失敗してもテスト結果には影響させない
        }
    });

    return root;
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { useTempRoot, writeJson, readJson };
