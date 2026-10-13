'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { useTempRoot, writeJson } = require('./helpers');

const ROOT = useTempRoot();

const channels = require('../lib/channels');
const { createRoles } = require('../web/lib/roles');

writeJson(path.join(ROOT, 'config', 'operators.json'), { operators: ['Op_One'] });
channels.create('op_one');       // 運営者は自分のチャンネルも持つ（D13）
channels.create('streamer_a');
channels.create('streamer_b');

const roles = createRoles({ allowedUsers: ['legacy_op'] });
const op = { login: 'op_one' };
const a = { login: 'streamer_a' };
const stranger = { login: 'random_viewer' };

test('運営者・登録済みの配信者・旧形式の allowedUsers だけが入れる', () => {
    assert.strictEqual(roles.isAllowed(op), true);
    assert.strictEqual(roles.isAllowed(a), true);
    assert.strictEqual(roles.isAllowed({ login: 'legacy_op' }), true);
    assert.strictEqual(roles.isAllowed(stranger), false);
    assert.strictEqual(roles.isAllowed(null), false);
    assert.strictEqual(roles.isAllowed({ login: '../etc' }), false);
});

test('運営者だけの操作', () => {
    for (const action of ['channels.list', 'channels.register', 'channels.delete', 'shared.config', 'audit.all']) {
        assert.strictEqual(roles.can(op, action), true, action);
        assert.strictEqual(roles.can(a, action), false, action);
    }
});

test('配信者は自分のチャンネルだけ。他人のチャンネルには何もできない', () => {
    for (const action of ['channel.status', 'channel.control', 'channel.logs', 'channel.audit', 'channel.config', 'channel.lists', 'channel.secrets', 'channel.usage']) {
        assert.strictEqual(roles.can(a, action, 'streamer_a'), true, 'own ' + action);
        assert.strictEqual(roles.can(a, action, 'streamer_b'), false, 'other ' + action);
    }
});

test('運営者は他人のチャンネルの状態・起動停止・ログ・記録は見られるが、設定・リスト・秘密の値は触れない（D18）', () => {
    for (const action of ['channel.status', 'channel.control', 'channel.logs', 'channel.audit']) {
        assert.strictEqual(roles.can(op, action, 'streamer_a'), true, action);
    }
    for (const action of ['channel.config', 'channel.lists', 'channel.secrets', 'channel.usage']) {
        assert.strictEqual(roles.can(op, action, 'streamer_a'), false, action);
        assert.strictEqual(roles.can(op, action, 'op_one'), true, 'own ' + action);
    }
});

test('未登録・不正なチャンネルと未知の操作は拒否する', () => {
    assert.strictEqual(roles.can(op, 'channel.status', 'nobody_here'), false);
    assert.strictEqual(roles.can(op, 'channel.status', '../config'), false);
    assert.strictEqual(roles.can(op, 'something.else', 'streamer_a'), false);
    assert.strictEqual(roles.can(stranger, 'channel.status', 'streamer_a'), false);
});

test('チャンネルを削除するとすぐに入れなくなる（リクエストごとの再確認）', () => {
    channels.create('streamer_gone');
    assert.strictEqual(roles.isAllowed({ login: 'streamer_gone' }), true);

    channels.removeFiles('streamer_gone');
    assert.strictEqual(roles.isAllowed({ login: 'streamer_gone' }), false);
});

test('運営者の一覧から外すとすぐに運営者の操作ができなくなる', () => {
    writeJson(path.join(ROOT, 'config', 'operators.json'), { operators: [] });

    try {
        assert.strictEqual(roles.can(op, 'channels.register'), false);
        // 自分のチャンネルの配信者としては残る
        assert.strictEqual(roles.can(op, 'channel.config', 'op_one'), true);
    } finally {
        writeJson(path.join(ROOT, 'config', 'operators.json'), { operators: ['op_one'] });
    }
});
