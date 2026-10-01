'use strict';

const session = require('express-session');

/**
 * 上限付きのメモリのセッション保存先（D16）。
 * express-session の既定の MemoryStore は上限も期限切れの掃除もないため、公開すると誰でもメモリを増やせる。
 *
 * - ログイン済みのセッション: Cookie の期限（既定 12 時間）まで保持する
 * - 未ログインのセッション（OAuth の state だけを持つもの）: 短い期限（既定 10 分）で破棄する
 * - 件数の上限を超えたら、期限切れ → 未ログイン → 古い順に追い出す
 * ディスクには何も書かないので、管理プロセスを再起動すると全員ログアウトされる。
 */
class BoundedMemoryStore extends session.Store {
    constructor(options) {
        super();

        const opts = options || {};

        this.maxSessions = opts.maxSessions || 1000;
        this.anonymousTtlMs = opts.anonymousTtlMs || 10 * 60 * 1000;
        this.defaultTtlMs = opts.defaultTtlMs || 12 * 60 * 60 * 1000;
        this.now = opts.now || Date.now;
        this.sessions = new Map();

        if (opts.pruneIntervalMs !== 0) {
            this.timer = setInterval(() => this.prune(), opts.pruneIntervalMs || 60 * 1000);
            this.timer.unref();
        }
    }

    expiresFor(sess) {
        const now = this.now();

        if (!sess || !sess.user) {
            return now + this.anonymousTtlMs;
        }

        const cookieExpires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : NaN;

        return Number.isFinite(cookieExpires) ? cookieExpires : now + this.defaultTtlMs;
    }

    get(sid, callback) {
        const entry = this.sessions.get(sid);

        if (!entry) { return callback(null, null); }

        if (entry.expires <= this.now()) {
            this.sessions.delete(sid);
            return callback(null, null);
        }

        try {
            return callback(null, JSON.parse(entry.data));
        } catch (err) {
            this.sessions.delete(sid);
            return callback(null, null);
        }
    }

    set(sid, sess, callback) {
        const entry = { data: JSON.stringify(sess), expires: this.expiresFor(sess), login: sess && sess.user ? sess.user.login : null };

        // 入れ直して「最近使った順」の末尾に回す
        this.sessions.delete(sid);

        if (this.sessions.size >= this.maxSessions) {
            this.makeRoom();
        }

        this.sessions.set(sid, entry);

        if (callback) { callback(null); }
    }

    touch(sid, sess, callback) {
        const entry = this.sessions.get(sid);

        if (entry) {
            entry.expires = this.expiresFor(sess);
            this.sessions.delete(sid);
            this.sessions.set(sid, entry);
        }

        if (callback) { callback(null); }
    }

    destroy(sid, callback) {
        this.sessions.delete(sid);

        if (callback) { callback(null); }
    }

    length(callback) {
        callback(null, this.sessions.size);
    }

    clear(callback) {
        this.sessions.clear();

        if (callback) { callback(null); }
    }

    /** 期限切れのセッションを捨てる */
    prune() {
        const now = this.now();
        let removed = 0;

        for (const [sid, entry] of this.sessions) {
            if (entry.expires <= now) {
                this.sessions.delete(sid);
                removed++;
            }
        }

        return removed;
    }

    /** 上限に達したときに 1 件分の空きを作る */
    makeRoom() {
        if (this.prune() > 0) { return; }

        for (const [sid, entry] of this.sessions) {
            if (!entry.login) {
                this.sessions.delete(sid);
                return;
            }
        }

        const oldest = this.sessions.keys().next();

        if (!oldest.done) { this.sessions.delete(oldest.value); }
    }

    /** あるユーザーのセッションをすべて無効にする（チャンネルの削除時など: 仕様書 11 節） */
    destroyByLogin(login) {
        const target = String(login || '').toLowerCase();
        let removed = 0;

        for (const [sid, entry] of this.sessions) {
            if (entry.login && entry.login.toLowerCase() === target) {
                this.sessions.delete(sid);
                removed++;
            }
        }

        return removed;
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); }
    }
}

module.exports = { BoundedMemoryStore };
