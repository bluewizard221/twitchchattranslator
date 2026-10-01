'use strict';

/**
 * 接続元ごとの単純な回数制限（固定ウィンドウ）。
 * 公開すると誰でも OAuth の開始などを繰り返せるため、/auth と /api に上限をかける（仕様書 10・12 節）。
 * プロキシ越しの場合は app の trust proxy 設定により req.ip が実際の接続元になる。
 *
 * @param {{ windowMs?: number, max: number, now?: () => number, maxKeys?: number }} options
 */
function rateLimit(options) {
    const windowMs = options.windowMs || 60 * 1000;
    const max = options.max;
    const now = options.now || Date.now;
    const maxKeys = options.maxKeys || 10000;
    const hits = new Map();

    function prune(current) {
        for (const [key, entry] of hits) {
            if (entry.resetAt <= current) { hits.delete(key); }
        }
    }

    function middleware(req, res, next) {
        const current = now();
        const key = req.ip || 'unknown';
        let entry = hits.get(key);

        if (!entry || entry.resetAt <= current) {
            if (hits.size >= maxKeys) { prune(current); }

            entry = { count: 0, resetAt: current + windowMs };
            hits.set(key, entry);
        }

        entry.count++;

        if (entry.count > max) {
            res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - current) / 1000)));

            if (req.originalUrl.startsWith('/api/')) {
                return res.status(429).json({ error: 'リクエストが多すぎます。しばらく待ってから再度お試しください。', code: 'rate_limited' });
            }

            return res.status(429).type('text/plain; charset=utf-8').send('429 Too Many Requests');
        }

        return next();
    }

    middleware.reset = () => hits.clear();

    return middleware;
}

module.exports = { rateLimit };
