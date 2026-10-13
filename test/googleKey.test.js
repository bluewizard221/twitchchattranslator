'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { useTempRoot } = require('./helpers');

useTempRoot();

const channels = require('../lib/channels');
const paths = require('../lib/paths');
const googleKey = require('../web/lib/googleKey');

const VALID_KEY = {
    type: 'service_account',
    project_id: 'my-project',
    private_key_id: 'abc123',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n',
    client_email: 'translator@my-project.iam.gserviceaccount.com',
    client_id: '1234567890'
};

channels.create('alice');

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

test('type が service_account でないキー・必須項目のないキーは拒否する', () => {
    assert.strictEqual(googleKey.validateKeyContent(JSON.stringify({ type: 'authorized_user', project_id: 'x' })).ok, false);
    assert.strictEqual(googleKey.validateKeyContent(JSON.stringify(Object.assign({}, VALID_KEY, { private_key: '' }))).ok, false);
    assert.strictEqual(googleKey.validateKeyContent(JSON.stringify([VALID_KEY])).ok, false);
});

test('大きすぎるファイルは拒否する', () => {
    const big = JSON.stringify(Object.assign({}, VALID_KEY, { padding: 'x'.repeat(googleKey.MAX_KEY_BYTES) }));

    assert.strictEqual(googleKey.validateKeyContent(big).ok, false);
});

test('キーはチャンネルの secrets/google-key.json に 600 で保存し、退避ファイルを残さない', () => {
    googleKey.saveForChannel('alice', JSON.stringify(VALID_KEY));
    const result = googleKey.saveForChannel('alice', JSON.stringify(Object.assign({}, VALID_KEY, { project_id: 'second' })));
    const file = paths.channel('alice').googleKey;

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.projectId, 'second');
    assert.strictEqual((fs.statSync(file).mode & 0o777).toString(8), '600');
    assert.deepStrictEqual(fs.readdirSync(paths.channel('alice').secretsDir), ['google-key.json']);
});

test('状態には秘密鍵を含めない', () => {
    const status = googleKey.statusForChannel('alice');

    assert.strictEqual(status.valid, true);
    assert.strictEqual(status.projectId, 'second');
    assert.strictEqual(status.mode, '0600');
    assert.ok(JSON.stringify(status).indexOf('PRIVATE KEY') === -1);
});

test('削除するとファイルがなくなり、状態は未アップロードになる', () => {
    assert.strictEqual(googleKey.removeForChannel('alice'), true);
    assert.strictEqual(googleKey.removeForChannel('alice'), false);
    assert.strictEqual(googleKey.statusForChannel('alice').exists, false);
});
