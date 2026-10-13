'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { useTempRoot } = require('./helpers');

useTempRoot();

const paths = require('../lib/paths');
const audit = require('../lib/audit');

test('記録がなければ空', () => {
    assert.deepStrictEqual(audit.read(), []);
    assert.strictEqual(audit.prune(365), 0);
});

test('追記した記録を新しい順に、チャンネルで絞って読める', () => {
    audit.append({ actor: 'op', action: 'channel.register', channel: 'alice' });
    audit.append({ actor: 'bob', action: 'config.update', channel: 'bob', detail: { keys: ['coolDownCount'] } });
    audit.append({ actor: 'alice', action: 'lists.update', channel: 'alice' });

    assert.deepStrictEqual(audit.read().map((e) => e.action), ['lists.update', 'config.update', 'channel.register']);
    assert.deepStrictEqual(audit.read({ channel: 'alice' }).map((e) => e.action), ['lists.update', 'channel.register']);
    assert.strictEqual(audit.read({ limit: 1 }).length, 1);
    assert.strictEqual((fs.statSync(paths.AUDIT_LOG).mode & 0o777).toString(8), '640');
});

test('壊れた行は読み飛ばす', () => {
    fs.appendFileSync(paths.AUDIT_LOG, '{broken\n');

    assert.strictEqual(audit.read().length, 3);
});

test('保存期間を過ぎた記録を捨てる（1 年）', () => {
    const now = Date.now();
    const old = JSON.stringify({ at: new Date(now - 400 * 86400000).toISOString(), actor: 'x', action: 'login', channel: null, detail: null });

    fs.writeFileSync(paths.AUDIT_LOG, old + '\n' + fs.readFileSync(paths.AUDIT_LOG, 'utf8'));

    assert.strictEqual(audit.prune(audit.RETENTION_DAYS, now), 1);
    assert.ok(fs.readFileSync(paths.AUDIT_LOG, 'utf8').indexOf('{broken') === -1, '書き直すときに壊れた行も消える');
    assert.strictEqual(audit.read().length, 3);
    assert.strictEqual(audit.prune(audit.RETENTION_DAYS, now), 0);
});
