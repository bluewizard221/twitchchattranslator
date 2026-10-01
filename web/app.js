'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');

const { createAuthRouter } = require('./routes/auth');
const { createApiRouter } = require('./routes/api');
const { requireAuth, ensureCsrfToken } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');
const { createRoles } = require('./lib/roles');
const { BoundedMemoryStore } = require('./lib/sessionStore');

const PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * 管理画面の Express アプリケーションを組み立てる。
 * @param {object} config web/lib/webConfig.load() の戻り値
 * @param {object} logger log4js 互換のロガー
 */
function createApp(config, logger) {
    const app = express();
    const roles = createRoles(config);
    const sessionStore = new BoundedMemoryStore({
        maxSessions: config.maxSessions,
        defaultTtlMs: config.sessionMaxAgeMs
    });

    // チャンネルの削除時にセッションを無効にするなど、ほかの処理から使えるようにしておく
    app.locals.roles = roles;
    app.locals.sessionStore = sessionStore;

    app.disable('x-powered-by');

    if (config.trustProxy) {
        app.set('trust proxy', 1);
    }

    // 外部リソースを一切読み込まない画面なので、自己ホスト以外は既定で拒否する
    app.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', [
            "default-src 'self'",
            "img-src 'self' data: https://static-cdn.jtvnw.net",
            "style-src 'self'",
            "script-src 'self'",
            "connect-src 'self'",
            "form-action 'self' https://id.twitch.tv",
            "frame-ancestors 'none'",
            "base-uri 'self'"
        ].join('; '));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        next();
    });

    app.use(session({
        name: 'tct.sid',
        store: sessionStore,
        secret: config.sessionSecret,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: config.secureCookie,
            maxAge: config.sessionMaxAgeMs
        }
    }));

    app.use(express.json({ limit: '2mb' }));

    app.use((req, res, next) => {
        if (req.session) { ensureCsrfToken(req); }
        next();
    });

    // ログイン処理（認証不要。公開すると誰でも呼べるので回数制限をかける）
    app.use('/auth', rateLimit({ max: config.rateLimitAuthPerMinute }), createAuthRouter(config, logger, roles));

    // 画面
    app.get('/', requireAuth(roles), (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    });

    app.get('/login', (req, res) => {
        if (req.session && req.session.user && roles.isAllowed(req.session.user)) {
            return res.redirect('/');
        }

        res.set('Cache-Control', 'no-store');
        res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
    });

    // API（すべてログイン必須）
    app.use('/api', rateLimit({ max: config.rateLimitApiPerMinute }), requireAuth(roles), createApiRouter(config, logger));

    // CSS / JS などの静的ファイル
    app.use(express.static(PUBLIC_DIR, { index: false, dotfiles: 'ignore', maxAge: '5m' }));

    app.use((req, res) => {
        if (req.originalUrl.startsWith('/api/')) {
            return res.status(404).json({ error: '存在しない API です。' });
        }

        res.status(404).type('text/plain; charset=utf-8').send('404 Not Found');
    });

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
            return res.status(400).json({ error: '送信されたデータを読み取れませんでした。' });
        }

        logger.error('未処理のエラー: ' + (err && err.stack ? err.stack : err));

        if (res.headersSent) { return; }

        if (req.originalUrl.startsWith('/api/')) {
            return res.status(500).json({ error: 'サーバー内部でエラーが発生しました。詳細は logs/webui.log を確認してください。' });
        }

        res.status(500).type('text/plain; charset=utf-8').send('500 Internal Server Error');
    });

    return app;
}

module.exports = { createApp, PUBLIC_DIR };
