'use strict';

const crypto = require('crypto');

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
 * 権限（運営者・登録済みの配信者）はリクエストごとに再確認するため、
 * 運営者の一覧から外したり、チャンネルを削除したりしたユーザーは次のアクセスで弾かれる。
 * @param {object} roles web/lib/roles.js の createRoles() の戻り値
 */
function requireAuth(roles) {
    return function (req, res, next) {
        const user = req.session && req.session.user;

        if (!user || !roles.isAllowed(user)) {
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
