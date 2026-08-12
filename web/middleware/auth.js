'use strict';

const crypto = require('crypto');
const webConfig = require('../lib/webConfig');

/** セッションごとの CSRF トークンを用意する */
function ensureCsrfToken(req) {
    if (!req.session) { return null; }

    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }

    return req.session.csrfToken;
}

function timingSafeEqual(a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');

    if (bufA.length === 0 || bufA.length !== bufB.length) { return false; }

    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * ログイン必須。API へは 401 JSON、画面へはログインページへのリダイレクトを返す。
 * 許可ユーザー一覧はリクエストごとに再確認するため、設定から外したユーザーは次のアクセスで弾かれる。
 */
function requireAuth(config) {
    return function (req, res, next) {
        const user = req.session && req.session.user;

        if (!user || !webConfig.isAllowed(config, user.login)) {
            if (user) {
                req.session.user = null;
            }

            // ルーターにマウントされると req.path は相対パスになるため originalUrl で判定する
            if (req.originalUrl.startsWith('/api/')) {
                return res.status(401).json({ error: 'ログインが必要です。', code: 'unauthenticated' });
            }

            return res.redirect('/login');
        }

        return next();
    };
}

/** 更新系リクエストに CSRF トークンを要求する */
function requireCsrf(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
        return next();
    }

    const expected = req.session && req.session.csrfToken;
    const provided = req.get('x-csrf-token');

    if (!expected || !timingSafeEqual(expected, provided)) {
        return res.status(403).json({
            error: 'セッションの有効期限が切れている可能性があります。ページを再読み込みしてください。',
            code: 'csrf'
        });
    }

    return next();
}

module.exports = { ensureCsrfToken, requireAuth, requireCsrf, timingSafeEqual };
