'use strict';

/**
 * 画面（web/public）と API の食い違いの検査。
 * ブラウザでの動作確認の代わりにはならないが、ID の書き間違いや、なくなった API を呼び続けることを防ぐ。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'web', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(__dirname, '..', 'web', 'routes', 'api.js'), 'utf8');

function matches(re, text) {
    const result = [];
    let m;

    while ((m = re.exec(text)) !== null) { result.push(m[1]); }

    return Array.from(new Set(result));
}

const htmlIds = new Set(matches(/\sid="([^"]+)"/g, html));

test('app.js が参照する ID はすべて index.html にある', () => {
    const used = matches(/\$\('([^']+)'\)/g, js).concat(matches(/getElementById\('([^']+)'\)/g, js));
    const missing = used.filter((id) => !htmlIds.has(id));

    assert.ok(used.length > 30, '参照を拾えていない');
    assert.deepStrictEqual(missing, []);
});

test('タブとビューが一対一で対応し、どのタブにも読み込み処理がある', () => {
    const tabs = matches(/data-view="([^"]+)"/g, html);
    const views = matches(/id="view-([^"]+)"/g, html);

    assert.deepStrictEqual(tabs.slice().sort(), views.slice().sort());

    for (const name of tabs) {
        assert.ok(new RegExp('\\n\\s+' + name + ': ').test(js), 'LOADERS に ' + name + ' がない');
    }
});

test('タブにはすべて役割（data-role）が付いている', () => {
    const tabs = html.match(/<button[^>]*class="tab[^"]*"[^>]*>/g);

    assert.ok(tabs.length >= 8);
    for (const tab of tabs) {
        assert.match(tab, /data-role="(owner|operator|any)"/);
    }
});

test('app.js が呼ぶチャンネルの API はすべて api.js にある', () => {
    const paths = matches(/own\('([^']*)'/g, js);

    assert.ok(paths.length >= 8);

    for (const p of paths) {
        assert.ok(apiSource.indexOf("'/channels/:login" + p) !== -1 || (p === '/' && apiSource.indexOf("'/channels/:login/' + op") !== -1),
            'api.js に /channels/:login' + p + ' がない');
    }
});

test('app.js が呼ぶ運営者の API はすべて api.js にある', () => {
    const paths = matches(/'\/api(\/[a-z/]+)'/g, js);

    assert.ok(paths.length >= 5);

    for (const p of paths) {
        // '/api/channels/' + login のように後ろをつなぐものは、パラメーター付きの経路として探す
        const found = p.endsWith('/')
            ? apiSource.indexOf("'" + p + ':') !== -1
            : apiSource.indexOf("'" + p + "'") !== -1 || apiSource.indexOf("'" + p + '/:') !== -1;

        assert.ok(found, 'api.js に ' + p + ' がない');
    }
});

test('古い API（単一チャンネル版）を呼んでいない', () => {
    for (const old of ['/api/config', '/api/lists', '/api/overview', '/api/google-key', '/api/bot/', '/api/emotes/', "'/api/logs"]) {
        assert.strictEqual(js.indexOf(old), -1, old + ' を呼んでいる');
    }
});
