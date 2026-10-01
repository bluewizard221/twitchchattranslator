'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { useTempRoot } = require('./helpers');

const ROOT = useTempRoot();

const bot = require('../web/lib/bot');

function writePid(content) {
    const file = path.join(ROOT, 'test.pid');
    require('fs').writeFileSync(file, content);
    return file;
}

test('通常の PID はそのまま読み取る', () => {
    const result = bot.readPid(writePid('12345\n'));

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.pid, 12345);
});

test('PID 1 が bot 自身なら許可する（コンテナ内で bot が PID 1 の場合）', () => {
    const result = bot.readPid(writePid('1'), { isBotProcess: () => true });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.pid, 1);
});

test('PID 1 が bot でなければ拒否する（ホスト上の init に送らない）', () => {
    const result = bot.readPid(writePid('1'), { isBotProcess: () => false });

    assert.strictEqual(result.ok, false);
    assert.ok(result.error.indexOf('PID 1') !== -1);
});

test('既定の判定では、このテストを動かしているマシンの PID 1（init）を bot とみなさない', () => {
    const result = bot.readPid(writePid('1'));

    assert.strictEqual(result.ok, false);
});

test('0・負数・数字以外は不正として拒否する', () => {
    for (const content of ['0', '-5', 'abc', '']) {
        assert.strictEqual(bot.readPid(writePid(content)).ok, false, JSON.stringify(content));
    }
});
