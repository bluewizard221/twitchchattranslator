'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rateLimit } = require('../web/middleware/rateLimit');

function fakeRes() {
    return {
        statusCode: 200,
        headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        type() { return this; },
        send(body) { this.body = body; return this; }
    };
}

test('上限を超えると 429、時間が経てばまた通る', () => {
    let now = 0;
    const limiter = rateLimit({ max: 3, windowMs: 60e3, now: () => now });
    const call = (ip) => {
        const res = fakeRes();
        let passed = false;

        limiter({ ip, originalUrl: '/auth/twitch' }, res, () => { passed = true; });
        return { passed, res };
    };

    for (let i = 0; i < 3; i++) { assert.strictEqual(call('1.1.1.1').passed, true); }

    const blocked = call('1.1.1.1');

    assert.strictEqual(blocked.passed, false);
    assert.strictEqual(blocked.res.statusCode, 429);
    assert.ok(Number(blocked.res.headers['Retry-After']) > 0);

    // 別の接続元には影響しない
    assert.strictEqual(call('2.2.2.2').passed, true);

    now += 61e3;
    assert.strictEqual(call('1.1.1.1').passed, true);
});

test('API には JSON で 429 を返す', () => {
    const limiter = rateLimit({ max: 0 });
    const res = fakeRes();

    limiter({ ip: 'x', originalUrl: '/api/config' }, res, () => assert.fail('通ってはいけない'));
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.body.code, 'rate_limited');
});
