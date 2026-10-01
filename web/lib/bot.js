'use strict';

const { createClient } = require('../../lib/ipc');

/**
 * 管理プロセス（manager.js）への操作の依頼。
 * 管理画面は管理プロセスの子プロセスとして動き、IPC で bot の起動・停止・再起動・リストの読み直しなどを頼む。
 * pid ファイルと SIGHUP を使う旧方式は廃止した（コンテナ内では bot が PID 1 だったため扱いが難しかった）。
 *
 * テストでは createManagerClient の代わりに、同じ形（request / available）の偽物を渡す。
 */
function createManagerClient(channel) {
    const client = createClient(channel || process, { timeoutMs: 30000 });

    return {
        available: client.available,
        request: client.request
    };
}

/** 管理プロセスがない（単独で起動した）ときの代わり。どの操作も分かりやすいエラーにする */
function unavailableManager() {
    return {
        available: () => false,
        request: async () => {
            throw new Error('管理プロセスに接続されていません。管理画面は manager.js から起動してください。');
        }
    };
}

module.exports = { createManagerClient, unavailableManager };
