'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempRoot, writeJson, readJson } = require('./helpers');

const ROOT = useTempRoot();

const lists = require('../lib/lists');

test('存在しないファイルは空のリストとして扱う', () => {
    const result = lists.read('ignoreusers');

    assert.deepStrictEqual(result.items, []);
    assert.strictEqual(result.error, null);
});

test('保存すると bot と同じ形式で書き出される', () => {
    const result = lists.write('ignoreusers', ['nightbot', 'moobot']);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(readJson(path.join(ROOT, 'ignoreusers.json')), { ignoreusers: ['nightbot', 'moobot'] });
});

test('空行と重複は取り除かれる', () => {
    const result = lists.write('emoticons', ['LuL', '', '  ', 'LuL', ' Kappa ']);

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.items, ['LuL', 'Kappa']);
    assert.strictEqual(result.removedDuplicates, 1);
});

test('不正なユーザー名は拒否される', () => {
    const result = lists.write('ignoreusers', ['ok_user', 'だめなユーザー']);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors.length, 1);
});

test('壊れた正規表現は拒否される', () => {
    const result = lists.write('ignoreline', ['[a-z]+', '([unclosed']);

    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].indexOf('正規表現') !== -1);
});

test('検証に失敗した場合はファイルを書き換えない', () => {
    lists.write('ignoreline', ['^https?://']);

    const before = fs.readFileSync(path.join(ROOT, 'ignoreline.json'), 'utf8');

    lists.write('ignoreline', ['([unclosed']);

    assert.strictEqual(fs.readFileSync(path.join(ROOT, 'ignoreline.json'), 'utf8'), before);
});

test('形式が違うファイルはエラーとして報告する', () => {
    writeJson(path.join(ROOT, 'emoticons.json'), { something: 'else' });

    const result = lists.read('emoticons');

    assert.deepStrictEqual(result.items, []);
    assert.ok(result.error);
});

test('未知のリスト ID は例外になる', () => {
    assert.throws(() => lists.read('../../../etc/passwd'), /不明なリスト/);
});

test('上書き時は .bak が作られる', () => {
    lists.write('ignoreusers', ['first_user']);
    lists.write('ignoreusers', ['second_user']);

    assert.deepStrictEqual(readJson(path.join(ROOT, 'ignoreusers.json.bak')), { ignoreusers: ['first_user'] });
});
