'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempRoot } = require('./helpers');

const ROOT = useTempRoot();

const logs = require('../web/lib/logs');

const LOG_FILE = path.join(ROOT, 'logs', 'twitchchattranslator.log');

function writeLog(text) {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE, text);
}

test('行数の指定は既定値と上限に丸める', () => {
    writeLog(Array.from({ length: 3000 }, (_, i) => '[INFO] line ' + i).join('\n') + '\n');

    assert.strictEqual(logs.tail('bot', {}).lines.length, logs.DEFAULT_LINES);
    assert.strictEqual(logs.tail('bot', { lines: 'abc' }).lines.length, logs.DEFAULT_LINES);
    assert.strictEqual(logs.tail('bot', { lines: 999999 }).lines.length, logs.MAX_LINES);
    assert.strictEqual(logs.tail('bot', { lines: 5 }).lines[4], '[INFO] line 2999');
});

test('大きなファイルは末尾だけを読み、欠けた先頭行は捨てる', () => {
    const line = '[INFO] ' + 'x'.repeat(1000);

    writeLog(Array.from({ length: 1000 }, () => line).join('\n') + '\n');

    const result = logs.tail('bot', { lines: 2000 });

    assert.strictEqual(result.truncated, true);
    assert.ok(result.lines.every((text) => text === line));
});

test('空のファイルでも失敗しない', () => {
    writeLog('');

    const result = logs.tail('bot', {});

    assert.strictEqual(result.exists, true);
    assert.deepStrictEqual(result.lines, []);
});

test('Bearer トークンやアクセストークンらしき値は伏せる', () => {
    writeLog('[ERROR] Authorization: Bearer abc.def-123456\n[INFO] {"access_token":"zzzzzzzzzzzz"}\n');

    const text = logs.tail('bot', {}).lines.join('\n');

    assert.strictEqual(text.indexOf('abc.def-123456'), -1);
    assert.strictEqual(text.indexOf('zzzzzzzzzzzz'), -1);
});

test('未知の ID は null を返す', () => {
    assert.strictEqual(logs.tail('../../etc/passwd', {}), null);
});
