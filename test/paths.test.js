'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

// TCT_ROOT を指定しない本番の起動方法で ROOT を求める（helpers は TCT_ROOT を設定するので別プロセスで確認する）
function rootWithoutEnv(cwd) {
    const env = Object.assign({}, process.env);
    delete env.TCT_ROOT;

    return execFileSync(process.execPath, ['-p', 'require(' + JSON.stringify(path.join(REPO_ROOT, 'lib', 'paths')) + ').ROOT'], {
        cwd: cwd,
        env: env,
        encoding: 'utf8'
    }).trim();
}

test('TCT_ROOT 未指定ならリポジトリのルートを指す', () => {
    assert.strictEqual(rootWithoutEnv(REPO_ROOT), REPO_ROOT);
});

test('起動時のカレントディレクトリに依存しない', () => {
    assert.strictEqual(rootWithoutEnv('/'), REPO_ROOT);
});
