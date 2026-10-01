'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempRoot, readJson } = require('./helpers');

const ROOT = useTempRoot();

const paths = require('../lib/paths');
const channels = require('../lib/channels');

test('ログイン名の検証: パスの組み立てに使えない値は拒否する', () => {
    for (const ok of ['bwscar221', 'abc', 'a_b_c', 'x'.repeat(25)]) {
        assert.strictEqual(paths.isValidLogin(ok), true, ok);
    }
    for (const bad of ['', 'ab', 'x'.repeat(26), 'Upper', '../etc', 'a/b', 'a.b', 'a b', null, undefined, 123]) {
        assert.strictEqual(paths.isValidLogin(bad), false, String(bad));
        assert.throws(() => paths.channel(bad));
    }
});

test('チャンネルのパスはすべて channels/<login>/ の下に収まる', () => {
    const p = paths.channel('streamer_a');

    for (const key of Object.keys(p)) {
        if (key === 'login') { continue; }
        assert.ok(p[key].startsWith(path.join(ROOT, 'channels', 'streamer_a')), key + ': ' + p[key]);
    }
});

test('登録すると、ディレクトリ・初期ファイル・パーミッションがそろう', () => {
    const result = channels.create('Streamer_A', { createdBy: 'op_one' });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.channel.login, 'streamer_a');

    const p = paths.channel('streamer_a');
    const mode = (file) => fs.statSync(file).mode & 0o777;

    assert.strictEqual(mode(p.secretsDir), 0o700);
    assert.strictEqual(mode(p.configDir), 0o700);
    assert.strictEqual(mode(p.localConfig), 0o600);
    assert.deepStrictEqual(readJson(p.localConfig), { config: { twitchChannel: 'streamer_a' } });
    assert.deepStrictEqual(readJson(p.ignoreUsers), { ignoreusers: [] });
    assert.deepStrictEqual(readJson(p.ignoreLines), { ignorelines: [] });
    assert.deepStrictEqual(readJson(p.emoticons), { emoticons: [] });
    assert.strictEqual(readJson(p.meta).createdBy, 'op_one');
    assert.strictEqual(channels.exists('streamer_a'), true);
});

test('二重登録と不正なログイン名は拒否する', () => {
    assert.strictEqual(channels.create('streamer_a').ok, false);
    assert.strictEqual(channels.create('../escape').ok, false);
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'escape')), false);
});

test('一覧はログイン名順で、channel.json の無いディレクトリは含めない', () => {
    channels.create('streamer_c');
    channels.create('streamer_b');
    fs.mkdirSync(path.join(ROOT, 'channels', 'not_registered'), { recursive: true });

    assert.deepStrictEqual(channels.list().map((c) => c.login), ['streamer_a', 'streamer_b', 'streamer_c']);
    assert.strictEqual(channels.exists('not_registered'), false);
});

test('削除すると秘密の値を含むディレクトリが丸ごと消える', () => {
    const p = paths.channel('streamer_b');

    fs.writeFileSync(p.botTokens, '{"accessToken":"x"}', { mode: 0o600 });
    fs.writeFileSync(p.googleKey, '{"private_key":"x"}', { mode: 0o600 });

    assert.strictEqual(channels.removeFiles('streamer_b'), true);
    assert.strictEqual(fs.existsSync(p.root), false);
    assert.strictEqual(channels.exists('streamer_b'), false);
    assert.strictEqual(channels.removeFiles('streamer_b'), false);
    assert.strictEqual(channels.removeFiles('../config'), false);
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'config')), true);
});
