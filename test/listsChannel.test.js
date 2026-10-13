'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { useTempRoot, readJson } = require('./helpers');

const ROOT = useTempRoot();

const channels = require('../lib/channels');
const paths = require('../lib/paths');
const lists = require('../lib/lists');

channels.create('chan_a');
channels.create('chan_b');

test('チャンネルを指定したリストは、そのチャンネルのファイルだけを読み書きする', () => {
    const a = lists.forChannel('chan_a');

    assert.strictEqual(a.write('ignoreusers', ['nightbot', 'nightbot']).ok, true);
    assert.deepStrictEqual(readJson(paths.channel('chan_a').ignoreUsers), { ignoreusers: ['nightbot'] });
    assert.deepStrictEqual(lists.forChannel('chan_b').read('ignoreusers').items, []);
    assert.deepStrictEqual(a.read('ignoreusers').items, ['nightbot']);
    assert.ok(a.describeAll()[0].path.startsWith(path.join(ROOT, 'channels', 'chan_a')));
});

test('不正なチャンネル名は扱えない', () => {
    assert.throws(() => lists.forChannel('../config'));
});
