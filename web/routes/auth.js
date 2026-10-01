'use strict';

const crypto = require('crypto');
const express = require('express');
const twitch = require('../lib/twitch');
const channels = require('../../lib/channels');
const audit = require('../../lib/audit');
const configStore = require('../lib/configStore');
const botConnection = require('../lib/botConnection');
const { notifyManager } = require('../lib/channelOps');
const { ensureCsrfToken, timingSafeEqual } = require('../middleware/auth');

// ログイン時に求める許可。登録済みの配信者は、これで bot がチャンネルで受信・投稿できるようになる（仕様書 6 節の手順 2）
const LOGIN_SCOPE = 'channel:bot';

/**
 * ログインと bot アカウントの接続（Twitch OAuth）。
 * Twitch に登録できる戻り先は 1 つなので、どちらも /auth/twitch/callback で受け、セッションに保存した目的で区別する。
 * ログイン時のトークンはセッションに保存しない（本人確認にだけ使い、自然に失効させる）。
 *
 * @param {object} deps { manager }
 */
function createAuthRouter(config, logger, roles, deps) {
    const router = express.Router();
    const manager = deps.manager;

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

    function startOAuth(req, res, pending, scope, forceVerify) {
        const state = crypto.randomBytes(24).toString('hex');

        req.session.oauth = Object.assign({ state }, pending);
        req.session.save((err) => {
            if (err) {
                logger.error('セッションの保存に失敗しました: ' + err.message);
                return res.redirect('/login?error=session');
            }

            res.redirect(twitch.buildAuthorizeUrl({
                clientId: config.clientId,
                redirectUri: config.redirectUri,
                state,
                scope,
                forceVerify
            }));
        });
    }

    // ログイン（Twitch の認可画面へ）
    router.get('/twitch', (req, res) => {
        if (config.errors.length > 0) {
            return res.redirect('/login?error=setup');
        }

        startOAuth(req, res, { purpose: 'login' }, LOGIN_SCOPE, false);
    });

    // bot アカウントの接続（ログイン済みの配信者本人だけ。bot アカウントでログインし直してもらうので force_verify）
    router.get('/bot/:login', (req, res) => {
        const user = req.session && req.session.user;
        const login = channels.normalize(req.params.login);

        if (!user || !roles.can(user, 'channel.secrets', login)) {
            return res.status(403).type('text/plain; charset=utf-8').send('このチャンネルの bot アカウントを接続する権限がありません。');
        }

        startOAuth(req, res, { purpose: 'bot', channel: login }, botConnection.REQUIRED_SCOPES.join(' '), true);
    });

    // Twitch からのコールバック
    router.get('/twitch/callback', async (req, res) => {
        const pending = req.session ? req.session.oauth : null;

        if (req.session) { req.session.oauth = null; }

        const isBot = !!(pending && pending.purpose === 'bot');
        const fail = (code, message) => {
            if (isBot) {
                req.session.flash = { type: 'error', text: message || 'bot アカウントの接続に失敗しました。' };
                return req.session.save(() => res.redirect('/#channel'));
            }
            return res.redirect('/login?error=' + code);
        };

        if (req.query.error) {
            logger.warn('Twitch 認可が拒否されました: ' + req.query.error);
            return fail('cancelled', 'Twitch での許可がキャンセルされました。');
        }

        const code = typeof req.query.code === 'string' ? req.query.code : '';
        const state = typeof req.query.state === 'string' ? req.query.state : '';

        if (!code) { return fail('oauth'); }
        if (!pending || !timingSafeEqual(pending.state, state)) {
            logger.warn('OAuth state が一致しませんでした。');
            return res.redirect('/login?error=state');
        }

        let token;
        let user;

        try {
            token = await twitch.exchangeCode({ clientId: config.clientId, clientSecret: config.clientSecret, code, redirectUri: config.redirectUri });
            user = await twitch.getAuthenticatedUser({ clientId: config.clientId, accessToken: token.access_token });
        } catch (err) {
            logger.error('Twitch の認可の処理に失敗しました: ' + err.message);
            return fail('oauth');
        }

        return isBot ? finishBot(req, res, pending, token, user, fail) : finishLogin(req, res, token, user);
    });

    async function finishLogin(req, res, token, user) {
        if (!roles.isAllowed({ login: user.login })) {
            logger.warn('許可されていないユーザーのログイン試行: ' + user.login);
            await twitch.revokeToken({ clientId: config.clientId, token: token.access_token });
            return res.redirect('/login?error=denied&login=' + encodeURIComponent(user.login));
        }

        const login = channels.normalize(user.login);

        // 登録済みの配信者なら、配信者の ID と channel:bot の許可を記録する（ユーザーは編集できない値）
        if (channels.exists(login)) {
            const scopes = Array.isArray(token.scope) ? token.scope : [];

            if (configStore.setBroadcasterId(login, user.id)) {
                await notifyManager(manager, 'channels.changed', {}, logger);
            }
            if (scopes.indexOf(LOGIN_SCOPE) !== -1) {
                channels.updateMeta(login, { channelBotGrantedAt: new Date().toISOString() });
            }
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
            ensureCsrfToken(req);
            audit.append({ actor: login, action: 'login', channel: channels.exists(login) ? login : null });
            logger.info('ログイン成功: ' + user.login + ' (id: ' + user.id + ')');

            req.session.save(() => res.redirect('/'));
        });
    }

    async function finishBot(req, res, pending, token, botUser, fail) {
        const user = req.session.user;
        const channel = pending.channel;

        if (!user || !roles.can(user, 'channel.secrets', channel)) {
            await twitch.revokeToken({ clientId: config.clientId, token: token.access_token });
            return res.redirect('/login');
        }

        const snapshot = configStore.channelSnapshot(channel);
        const broadcasterId = snapshot.twitchBroadcasterId || (channels.normalize(user.login) === channel ? String(user.id) : null);
        const saved = botConnection.save(channel, token, botUser, broadcasterId);

        if (!saved.ok) {
            await twitch.revokeToken({ clientId: config.clientId, token: token.access_token });
            logger.warn('bot アカウントの接続を拒否しました [' + channel + '] ' + saved.error);
            return fail('bot', saved.error);
        }

        audit.append({ actor: user.login, action: 'bot.connect', channel, detail: { botLogin: botUser.login } });
        logger.info('bot アカウントを接続しました [' + channel + '] bot: ' + botUser.login);
        await notifyManager(manager, 'channels.changed', {}, logger);

        req.session.flash = { type: 'ok', text: 'bot アカウント「' + botUser.login + '」を接続しました。' };
        req.session.save(() => res.redirect('/#channel'));
    }

    // ログアウト（CSRF 対策のため POST のみ）。トークンは保存していないので無効化はしない
    router.post('/logout', (req, res) => {
        const expected = req.session ? req.session.csrfToken : null;

        if (!expected || !timingSafeEqual(expected, req.get('x-csrf-token'))) {
            return res.status(403).json({ error: 'リクエストが無効です。ページを再読み込みしてください。' });
        }

        const login = req.session && req.session.user ? req.session.user.login : null;

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

module.exports = { createAuthRouter, LOGIN_SCOPE };
