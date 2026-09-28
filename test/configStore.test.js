'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { useTempRoot, writeJson, readJson } = require('./helpers');

const ROOT = useTempRoot();

const configStore = require('../web/lib/configStore');

const DEFAULT_CONFIG = path.join(ROOT, 'config', 'default.json');
const LOCAL_CONFIG = path.join(ROOT, 'config', 'local.json');

function resetConfig() {
    writeJson(DEFAULT_CONFIG, {
        config: {
            pidFile: 'テンプレートの値',
            twitchChannel: 'template_channel',
            twitchClientSecret: 'テンプレートの値',
            coolDownCount: 5
        }
    });

    try {
        require('fs').rmSync(LOCAL_CONFIG, { force: true });
    } catch (err) {
        // 未作成なら何もしない
    }
}

test('local.json は default.json より優先される', () => {
    resetConfig();
    writeJson(LOCAL_CONFIG, { config: { twitchChannel: 'real_channel' } });

    const effective = configStore.loadEffective();

    assert.strictEqual(effective.values.twitchChannel, 'real_channel');
    assert.strictEqual(effective.sources.twitchChannel, 'local.json');
    assert.strictEqual(effective.values.coolDownCount, 5);
    assert.strictEqual(effective.sources.coolDownCount, 'default.json');
});

test('snapshot は secret 項目の値を返さず、設定済みかどうかだけを返す', () => {
    resetConfig();
    writeJson(LOCAL_CONFIG, { config: { twitchClientSecret: 'とても秘密の値' } });

    const snapshot = configStore.snapshot();

    assert.strictEqual(snapshot.values.twitchClientSecret.value, null);
    assert.strictEqual(snapshot.values.twitchClientSecret.hasValue, true);
    assert.strictEqual(snapshot.values.twitchChannel.value, 'template_channel');

    // シリアライズしても秘密の値が混ざらないこと
    assert.strictEqual(JSON.stringify(snapshot).indexOf('とても秘密の値'), -1);
});

test('保存は config/local.json だけを書き換える', () => {
    resetConfig();

    const result = configStore.saveLocal({ twitchChannel: 'saved_channel', coolDownCount: '12' });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(readJson(LOCAL_CONFIG).config, { twitchChannel: 'saved_channel', coolDownCount: 12 });
    assert.strictEqual(readJson(DEFAULT_CONFIG).config.twitchChannel, 'template_channel');
});

test('secret 項目が空欄なら既存の値を保持する', () => {
    resetConfig();
    writeJson(LOCAL_CONFIG, { config: { twitchClientSecret: 'keep-me' } });

    const result = configStore.saveLocal({ twitchClientSecret: '', twitchChannel: 'another_channel' });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(readJson(LOCAL_CONFIG).config.twitchClientSecret, 'keep-me');
    assert.strictEqual(readJson(LOCAL_CONFIG).config.twitchChannel, 'another_channel');
});

test('不正な値は保存されずエラーを返す', () => {
    resetConfig();

    const result = configStore.saveLocal({
        twitchChannel: 'だめな チャンネル名',
        twitchBroadcasterId: 'abc',
        coolDownCount: '0'
    });

    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.twitchChannel);
    assert.ok(result.errors.twitchBroadcasterId);
    assert.ok(result.errors.coolDownCount);
    assert.strictEqual(require('fs').existsSync(LOCAL_CONFIG), false);
});

test('配信状態の確認間隔は省略でき、範囲外の値は拒否する', () => {
    resetConfig();

    assert.strictEqual(configStore.saveLocal({ streamStatusPollSeconds: '30' }).ok, true);
    assert.strictEqual(readJson(LOCAL_CONFIG).config.streamStatusPollSeconds, 30);

    const tooShort = configStore.saveLocal({ streamStatusPollSeconds: '5' });
    assert.strictEqual(tooShort.ok, false);
    assert.ok(tooShort.errors.streamStatusPollSeconds);

    // 空欄は local.json から取り消して既定値（60 秒）に戻す
    assert.strictEqual(configStore.saveLocal({ streamStatusPollSeconds: '' }).ok, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(readJson(LOCAL_CONFIG).config, 'streamStatusPollSeconds'), false);
});

test('未知の項目は拒否する', () => {
    resetConfig();

    const result = configStore.saveLocal({ '../../etc/passwd': 'x' });

    assert.strictEqual(result.ok, false);
    assert.ok(result.errors['../../etc/passwd']);
});

test('必須項目が空のままなら警告として返す', () => {
    resetConfig();

    const result = configStore.saveLocal({ twitchChannel: 'ok_channel' });

    assert.strictEqual(result.ok, true);
    assert.ok(result.missingRequired.some((item) => item.indexOf('bot のユーザー名') === 0));
});

test('未入力の必須項目があっても、入力済みの項目は保存できる', () => {
    resetConfig();

    const result = configStore.saveLocal({ twitchChannel: 'ok_channel', twitchUserName: '' });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(readJson(LOCAL_CONFIG).config.twitchChannel, 'ok_channel');
});

test('default.json の説明文がそのまま残っている項目は未設定として扱う', () => {
    resetConfig();

    const snapshot = configStore.snapshot();

    // "テンプレートの値" は日本語（非 ASCII）なので説明文とみなす
    assert.strictEqual(snapshot.values.pidFile.isPlaceholder, true);
    assert.strictEqual(snapshot.values.pidFile.hasValue, false);
    assert.strictEqual(snapshot.values.twitchClientSecret.isPlaceholder, true);

    // ASCII の値は利用者が入れた値として扱う
    assert.strictEqual(snapshot.values.twitchChannel.isPlaceholder, false);
    assert.strictEqual(snapshot.values.twitchChannel.hasValue, true);

    assert.strictEqual(configStore.usableValues().pidFile, undefined);
    assert.strictEqual(configStore.usableValues().twitchChannel, 'template_channel');

    const incomplete = configStore.incompleteRequired(
        configStore.loadEffective().values,
        configStore.loadEffective().sources
    );

    assert.ok(incomplete.some((item) => item.key === 'pidFile' && item.reason.indexOf('default.json') !== -1));
});

test('local.json に保存した値は日本語でも説明文とみなさない', () => {
    resetConfig();
    writeJson(LOCAL_CONFIG, { config: { pidFile: '/tmp/ぼっと.pid' } });

    const snapshot = configStore.snapshot();

    assert.strictEqual(snapshot.values.pidFile.isPlaceholder, false);
    assert.strictEqual(snapshot.values.pidFile.value, '/tmp/ぼっと.pid');
});

test('壊れた JSON はエラーとして報告される', () => {
    resetConfig();
    require('fs').writeFileSync(LOCAL_CONFIG, '{ "config": ');

    const snapshot = configStore.snapshot();
    const local = snapshot.layers.find((layer) => layer.name === 'local.json');

    assert.ok(local.error);
});
