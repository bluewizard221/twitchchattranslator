'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempRoot, writeJson, readJson } = require('./helpers');

const ROOT = useTempRoot();

const channels = require('../lib/channels');
const paths = require('../lib/paths');
const configStore = require('../web/lib/configStore');

const DEFAULT_CONFIG = path.join(ROOT, 'config', 'default.json');
const LOCAL_CONFIG = path.join(ROOT, 'config', 'local.json');

channels.create('alice');

test('チャンネルの設定は未設定なら既定値を返す', () => {
    const snapshot = configStore.channelSnapshot('alice');

    assert.deepStrictEqual(snapshot.values.coolDownCount, { value: 5, isDefault: true });
    assert.strictEqual(snapshot.twitchChannel, 'alice');
    assert.strictEqual(snapshot.twitchBroadcasterId, null);
});

test('チャンネルの設定を保存しても、システムが管理する値は残る', () => {
    configStore.setBroadcasterId('alice', '100');

    const result = configStore.saveChannel('alice', { coolDownCount: '8' });
    const saved = readJson(paths.channel('alice').localConfig).config;

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(saved, { twitchChannel: 'alice', twitchBroadcasterId: '100', coolDownCount: 8 });
    assert.strictEqual((fs.statSync(paths.channel('alice').localConfig).mode & 0o777).toString(8), '600');
});

test('チャンネルの設定では対象チャンネル・配信者 ID・未知の項目を受け付けない', () => {
    const result = configStore.saveChannel('alice', { twitchChannel: 'bob', twitchBroadcasterId: '1', pidFile: '/tmp/x', coolDownCount: 3 });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(Object.keys(result.errors).sort(), ['pidFile', 'twitchBroadcasterId', 'twitchChannel']);
    assert.strictEqual(readJson(paths.channel('alice').localConfig).config.coolDownCount, 8, '一部でも誤りがあれば保存しない');
});

test('任意項目を空欄にすると既定値に戻る。必須項目は空欄にできない', () => {
    configStore.saveChannel('alice', { dailyCharLimit: 1000 });
    assert.strictEqual(configStore.channelSnapshot('alice').values.dailyCharLimit.value, 1000);

    configStore.saveChannel('alice', { dailyCharLimit: '' });
    assert.deepStrictEqual(configStore.channelSnapshot('alice').values.dailyCharLimit, { value: 0, isDefault: true });

    assert.strictEqual(configStore.saveChannel('alice', { coolDownCount: '' }).ok, false);
});

test('数値の範囲を検証する', () => {
    assert.strictEqual(configStore.saveChannel('alice', { coolDownCount: 0 }).ok, false);
    assert.strictEqual(configStore.saveChannel('alice', { coolDownCount: 1.5 }).ok, false);
    assert.strictEqual(configStore.saveChannel('alice', { dailyCharLimit: -1 }).ok, false);
});

test('配信者の ID は変わったときだけ書き込む', () => {
    assert.strictEqual(configStore.setBroadcasterId('alice', '100'), false);
    assert.strictEqual(configStore.setBroadcasterId('alice', '101'), true);
    assert.strictEqual(configStore.channelSnapshot('alice').twitchBroadcasterId, '101');
});

test('共通の設定: 説明文のままの値は未設定とみなし、秘密の値は返さない', () => {
    writeJson(DEFAULT_CONFIG, { config: { twitchClientId: 'abcdefghij12', twitchClientSecret: 'テンプレートの値', pidFile: 'x' } });

    const values = configStore.sharedSnapshot().values;

    assert.deepStrictEqual(values.twitchClientId, { value: 'abcdefghij12', hasValue: true, source: 'default.json' });
    assert.deepStrictEqual(values.twitchClientSecret, { value: null, hasValue: false, source: null });
});

test('共通の設定の保存は local.json の config と config.eventsub に入り、ほかの値は残す', () => {
    writeJson(LOCAL_CONFIG, { config: { pidFile: 'keep', eventsub: { other: 1 } }, extra: true });

    const result = configStore.saveShared({
        twitchClientSecret: 'real-secret',
        eventsubCallbackUrl: 'https://translate.example.com/eventsub/callback',
        eventsubSecret: '0123456789abcdef'
    });
    const saved = readJson(LOCAL_CONFIG);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(saved.extra, true);
    assert.strictEqual(saved.config.pidFile, 'keep');
    assert.strictEqual(saved.config.twitchClientSecret, 'real-secret');
    assert.deepStrictEqual(saved.config.eventsub, { other: 1, callbackUrl: 'https://translate.example.com/eventsub/callback', secret: '0123456789abcdef' });

    const values = configStore.sharedSnapshot().values;

    assert.strictEqual(values.twitchClientSecret.value, null);
    assert.strictEqual(values.twitchClientSecret.source, 'local.json');
    assert.strictEqual(values.eventsubCallbackUrl.value, 'https://translate.example.com/eventsub/callback');
});

test('共通の設定: 秘密の値は空欄なら変更しない。形式の誤りは拒否する', () => {
    assert.strictEqual(configStore.saveShared({ twitchClientSecret: '' }).ok, true);
    assert.strictEqual(readJson(LOCAL_CONFIG).config.twitchClientSecret, 'real-secret');

    const bad = configStore.saveShared({ eventsubCallbackUrl: 'https://example.com:8443/eventsub/callback', twitchClientId: 'UPPER' });

    assert.strictEqual(bad.ok, false);
    assert.deepStrictEqual(Object.keys(bad.errors).sort(), ['eventsubCallbackUrl', 'twitchClientId']);
});

test('相対パスと更新情報を返す', () => {
    assert.strictEqual(configStore.relativePath(paths.channel('alice').localConfig), 'channels/alice/config/local.json');
    assert.strictEqual(configStore.meta(LOCAL_CONFIG).exists, true);
});
