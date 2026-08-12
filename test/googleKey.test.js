'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempRoot } = require('./helpers');

const ROOT = useTempRoot();

const googleKey = require('../web/lib/googleKey');

const VALID_KEY = {
    type: 'service_account',
    project_id: 'my-project',
    private_key_id: 'abc123',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n',
    client_email: 'translator@my-project.iam.gserviceaccount.com',
    client_id: '1234567890'
};

test('正しいサービスアカウントキーを受け付ける', () => {
    const result = googleKey.validateKeyContent(JSON.stringify(VALID_KEY));

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.key.project_id, 'my-project');
});

test('JSON でない内容は拒否する', () => {
    const result = googleKey.validateKeyContent('これは JSON ではありません');

    assert.strictEqual(result.ok, false);
    assert.ok(result.error.indexOf('JSON') !== -1);
});

test('type が service_account でないキーは拒否する', () => {
    const result = googleKey.validateKeyContent(JSON.stringify({ type: 'authorized_user', project_id: 'x' }));

    assert.strictEqual(result.ok, false);
});

test('必須項目が欠けているキーは拒否する', () => {
    const incomplete = Object.assign({}, VALID_KEY);

    delete incomplete.client_email;

    const result = googleKey.validateKeyContent(JSON.stringify(incomplete));

    assert.strictEqual(result.ok, false);
    assert.ok(result.error.indexOf('client_email') !== -1);
});

test('保存先は config ディレクトリ配下に限定される', () => {
    assert.strictEqual(googleKey.resolveDestination('../../../tmp/evil.json'), path.join(ROOT, 'config', 'evil.json'));
    assert.strictEqual(googleKey.resolveDestination('/etc/passwd'), path.join(ROOT, 'config', 'google-key.json'));
    assert.strictEqual(googleKey.resolveDestination('key.txt'), path.join(ROOT, 'config', 'google-key.json'));
    assert.strictEqual(googleKey.resolveDestination('my key.json'), path.join(ROOT, 'config', 'google-key.json'));
    assert.strictEqual(googleKey.resolveDestination('sa-key.json'), path.join(ROOT, 'config', 'sa-key.json'));
});

test('保存したキーは所有者のみ読み書き可能になる', () => {
    const result = googleKey.save(JSON.stringify(VALID_KEY), 'sa-key.json');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.path, 'config/sa-key.json');
    assert.strictEqual(result.projectId, 'my-project');

    const stat = fs.statSync(path.join(ROOT, 'config', 'sa-key.json'));

    assert.strictEqual(stat.mode & 0o777, 0o600);
});

test('状態確認では秘密鍵を返さない', () => {
    googleKey.save(JSON.stringify(VALID_KEY), 'sa-key.json');

    const status = googleKey.status('config/sa-key.json');

    assert.strictEqual(status.valid, true);
    assert.strictEqual(status.clientEmail, VALID_KEY.client_email);
    assert.strictEqual(JSON.stringify(status).indexOf('BEGIN PRIVATE KEY'), -1);
});

test('存在しないパスは未設定として報告する', () => {
    const status = googleKey.status('config/missing.json');

    assert.strictEqual(status.exists, false);
    assert.strictEqual(status.valid, false);
});
