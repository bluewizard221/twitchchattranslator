'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempRoot } = require('./helpers');

useTempRoot();

const channels = require('../lib/channels');
const paths = require('../lib/paths');
const logs = require('../web/lib/logs');

channels.create('alice');

const ALICE = { type: 'channel', login: 'alice' };
const SYSTEM = { type: 'system' };
const LOG_FILE = path.join(paths.channel('alice').logDir, 'twitchchattranslator.log');

function writeLog(text) {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE, text);
}

test('行数の指定は既定値と上限に丸める', () => {
    writeLog(Array.from({ length: 3000 }, (_, i) => '[INFO] line ' + i).join('\n') + '\n');

    assert.strictEqual(logs.tail(ALICE, 'bot', {}).lines.length, logs.DEFAULT_LINES);
    assert.strictEqual(logs.tail(ALICE, 'bot', { lines: 'abc' }).lines.length, logs.DEFAULT_LINES);
    assert.strictEqual(logs.tail(ALICE, 'bot', { lines: 999999 }).lines.length, logs.MAX_LINES);
    assert.strictEqual(logs.tail(ALICE, 'bot', { lines: 5 }).lines[4], '[INFO] line 2999');
});

test('大きなファイルは末尾だけを読み、欠けた先頭行は捨てる', () => {
    const line = '[INFO] ' + 'x'.repeat(1000);

    writeLog(Array.from({ length: 1000 }, () => line).join('\n') + '\n');

    const result = logs.tail(ALICE, 'bot', { lines: 2000 });

    assert.strictEqual(result.truncated, true);
    assert.ok(result.lines.every((text) => text === line));
});

test('空のファイルでも失敗しない', () => {
    writeLog('');

    const result = logs.tail(ALICE, 'bot', {});

    assert.strictEqual(result.exists, true);
    assert.deepStrictEqual(result.lines, []);
});

test('Bearer トークンやアクセストークンらしき値は伏せる', () => {
    writeLog('[ERROR] Authorization: Bearer abc.def-123456\n[INFO] {"access_token":"zzzzzzzzzzzz"}\n');

    const text = logs.tail(ALICE, 'bot', {}).lines.join('\n');

    assert.strictEqual(text.indexOf('abc.def-123456'), -1);
    assert.strictEqual(text.indexOf('zzzzzzzzzzzz'), -1);
});

test('チャンネルのログとシステムのログは ID の範囲が分かれている', () => {
    assert.strictEqual(logs.tail(ALICE, 'manager', {}), null);
    assert.strictEqual(logs.tail(SYSTEM, 'bot', {}), null);
    assert.strictEqual(logs.tail(ALICE, '../../etc/passwd', {}), null);
    assert.strictEqual(logs.tail({ type: 'other' }, 'bot', {}), null);
});

test('システムのログは logs/ から読み、未作成なら exists: false', () => {
    const missing = logs.tail(SYSTEM, 'manager', {});

    assert.strictEqual(missing.exists, false);
    assert.strictEqual(missing.path, 'logs/manager.log');

    fs.mkdirSync(paths.LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(paths.LOG_DIR, 'manager.log'), '[WARN] a\n[INFO] b\n');

    assert.deepStrictEqual(logs.tail(SYSTEM, 'manager', { level: 'warn' }).lines, ['[WARN] a']);
});

test('一覧はスコープごとの定義だけを返す', () => {
    assert.deepStrictEqual(logs.describe(ALICE).map((d) => d.id), ['bot']);
    assert.deepStrictEqual(logs.describe(SYSTEM).map((d) => d.id), ['manager', 'webui']);
    assert.strictEqual(logs.describe(ALICE)[0].path, 'channels/alice/logs/twitchchattranslator.log');
});
