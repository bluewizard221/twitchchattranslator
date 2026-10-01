'use strict';

const paths = require('../../lib/paths');
const channels = require('../../lib/channels');
const { loadOperators } = require('./operators');

/**
 * 運営者と配信者の権限（仕様書 4 節）。
 * 判定はリクエストのたびに行い、ファイルを読み直す（運営者の一覧の変更やチャンネルの削除がすぐに効くように）。
 *
 * 運営者: config/operators.json の operators（互換のため webui.json の allowedUsers も運営者として扱う）
 * 配信者: channels/<login>/ が登録済みのログイン名
 * 運営者が自分のチャンネルを登録していれば、そのチャンネルについては配信者の権限も持つ（D13）。
 */

// 運営者だけができる操作（チャンネルを問わない）
const OPERATOR_ACTIONS = new Set([
    'channels.list',
    'channels.register',
    'channels.delete',
    'shared.config',
    'audit.all'
]);

// 運営者は他人のチャンネルにも行える操作。配信者は自分のチャンネルだけ
const OPERATOR_OR_OWNER_ACTIONS = new Set([
    'channel.status',
    'channel.control',
    'channel.logs',
    'channel.audit'
]);

// 配信者本人だけができる操作（運営者による代理の操作はしない: D18）
const OWNER_ACTIONS = new Set([
    'channel.config',
    'channel.lists',
    'channel.secrets',
    'channel.usage'
]);

/**
 * @param {{ allowedUsers?: string[] }} config webConfig.load() の戻り値（allowedUsers は旧形式の互換用）
 */
function createRoles(config) {
    const legacy = config && Array.isArray(config.allowedUsers) ? config.allowedUsers : [];

    function resolve(user) {
        const login = user && user.login ? channels.normalize(user.login) : '';

        if (!paths.isValidLogin(login)) {
            return { login: null, isOperator: false, channel: null };
        }

        return {
            login,
            isOperator: loadOperators(legacy).indexOf(login) !== -1,
            channel: channels.exists(login) ? login : null
        };
    }

    /** 管理画面に入れるか（運営者、または登録済みの配信者） */
    function isAllowed(user) {
        const role = resolve(user);

        return role.isOperator || role.channel !== null;
    }

    /**
     * 操作の可否。
     * @param {object} user セッションのユーザー（login を持つ）
     * @param {string} action 上の定数のいずれか
     * @param {string} [channelLogin] 対象のチャンネル
     */
    function can(user, action, channelLogin) {
        const role = resolve(user);

        if (!role.isOperator && role.channel === null) { return false; }

        if (OPERATOR_ACTIONS.has(action)) {
            return role.isOperator;
        }

        const target = channelLogin ? channels.normalize(channelLogin) : '';

        if (!paths.isValidLogin(target) || !channels.exists(target)) { return false; }

        const own = role.channel === target;

        if (OPERATOR_OR_OWNER_ACTIONS.has(action)) {
            return own || role.isOperator;
        }
        if (OWNER_ACTIONS.has(action)) {
            return own;
        }

        return false;
    }

    return { resolve, isAllowed, can, operators: () => loadOperators(legacy) };
}

module.exports = { createRoles, OPERATOR_ACTIONS, OPERATOR_OR_OWNER_ACTIONS, OWNER_ACTIONS };
