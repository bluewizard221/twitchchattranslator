'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { useTempRoot, readJson } = require('./helpers');

const ROOT = useTempRoot();
const { Usage } = require('../lib/bot/usage');

test('日・月ごとに数え、1 日の上限を判定し、ファイルに残す', () => {
    let now = new Date('2026-10-01T10:00:00+09:00').getTime();
    const usage = new Usage('chan_a', { now: () => now });

    usage.add(100);
    usage.add(50);
    assert.strictEqual(usage.today(), 150);
    assert.strictEqual(usage.exceeded(0), false, '0 は上限なし');
    assert.strictEqual(usage.exceeded(200), false);
    assert.strictEqual(usage.exceeded(150), true);

    now += 24 * 3600e3;
    assert.strictEqual(usage.today(), 0, '日付が変われば 0 から');
    assert.strictEqual(usage.month(), 150);

    const saved = readJson(path.join(ROOT, 'data', 'usage', 'chan_a.json'));

    assert.strictEqual(saved.days['2026-10-01'], 150);
    assert.strictEqual(new Usage('chan_a', { now: () => now }).month(), 150, '読み直しても残っている');
});
