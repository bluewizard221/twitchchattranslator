'use strict';

const crypto = require('crypto');
const express = require('express');
const twitch = require('../lib/twitch');
const { ensureCsrfToken, timingSafeEqual } = require('../middleware/auth');

function createAuthRouter(config, logger, roles) {
    const router = express.Router();

    // ログインページや管理画面から参照する公開ステータス
    router.get('/status', (req, res) => {
        const user = req.session && req.session.user;

        res.json({
            loggedIn: !!(user && roles.isAllowed(user)),
            login: user ? user.login : null,
            ready: config.errors.length === 0,
            errors: config.errors
        });
    });

    // Twitch の認可画面へ送り出す
    router.get('/twitch', (req, res) => {
        if (config.errors.length > 0) {
            return res.redirect('/login?error=setup');
        }

        const state = crypto.randomBytes(24).toString('hex');

        req.session.oauthState = state;
        req.session.save((err) => {
            if (err) {
                logger.error('セッションの保存に失敗しました: ' + err.message);
                return res.redirect('/login?error=session');
            }

            const url = twitch.buildAuthorizeUrl({
                clientId: config.clientId,
                redirectUri: config.redirectUri,
                state: state,
                // 追加の権限は要求しない（ログイン名と数値 ID の確認のみ）
                scope: '',
                forceVerify: false
            });

            res.redirect(url);
        });
    });

    // Twitch からのコールバック
    router.get('/twitch/callback', async (req, res) => {
        const expectedState = req.session ? req.session.oauthState : null;

        if (req.session) {
            req.session.oauthState = null;
        }

        if (req.query.error) {
            logger.warn('Twitch 認可が拒否されました: ' + req.query.error + ' ' + (req.query.error_description || ''));
            return res.redirect('/login?error=cancelled');
        }

        const code = typeof req.query.code === 'string' ? req.query.code : '';
        const state = typeof req.query.state === 'string' ? req.query.state : '';

        if (!code) {
            return res.redirect('/login?error=oauth');
        }
        if (!expectedState || !timingSafeEqual(expectedState, state)) {
            logger.warn('OAuth state が一致しませんでした。');
            return res.redirect('/login?error=state');
        }

        let token;
        let user;

        try {
            token = await twitch.exchangeCode({
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                code: code,
                redirectUri: config.redirectUri
            });

            user = await twitch.getAuthenticatedUser({
                clientId: config.clientId,
                accessToken: token.access_token
            });
        } catch (err) {
            logger.error('Twitch ログイン処理に失敗しました: ' + err.message);
            return res.redirect('/login?error=oauth');
        }

        if (!roles.isAllowed({ login: user.login })) {
            logger.warn('許可されていないユーザーのログイン試行: ' + user.login);

            if (token && token.access_token) {
                await twitch.revokeToken({ clientId: config.clientId, token: token.access_token });
            }

            return res.redirect('/login?error=denied&login=' + encodeURIComponent(user.login));
        }

        // セッション固定攻撃を避けるためログイン時に ID を作り直す
        req.session.regenerate((err) => {
            if (err) {
                logger.error('セッションの再生成に失敗しました: ' + err.message);
                return res.redirect('/login?error=session');
            }

            req.session.user = {
                id: user.id,
                login: user.login,
                displayName: user.displayName,
                profileImageUrl: user.profileImageUrl,
                broadcasterType: user.broadcasterType,
                loggedInAt: new Date().toISOString()
            };
            req.session.accessToken = token.access_token;
            ensureCsrfToken(req);

            logger.info('ログイン成功: ' + user.login + ' (id: ' + user.id + ')');

            req.session.save(() => res.redirect('/'));
        });
    });

    // ログアウト（CSRF 対策のため POST のみ）
    router.post('/logout', async (req, res) => {
        const expected = req.session ? req.session.csrfToken : null;

        if (!expected || !timingSafeEqual(expected, req.get('x-csrf-token'))) {
            return res.status(403).json({ error: 'リクエストが無効です。ページを再読み込みしてください。' });
        }

        const accessToken = req.session ? req.session.accessToken : null;
        const login = req.session && req.session.user ? req.session.user.login : null;

        if (accessToken) {
            await twitch.revokeToken({ clientId: config.clientId, token: accessToken });
        }

        req.session.destroy((err) => {
            if (err) {
                logger.error('セッションの破棄に失敗しました: ' + err.message);
                return res.status(500).json({ error: 'ログアウトに失敗しました。' });
            }

            if (login) { logger.info('ログアウト: ' + login); }

            res.clearCookie('tct.sid');
            res.json({ ok: true });
        });
    });

    return router;
}

module.exports = { createAuthRouter };
