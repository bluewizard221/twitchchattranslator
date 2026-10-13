'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * 子プロセスの起動・監視・再起動（仕様書 9 節）。
 *
 * - 異常終了したら間隔をあけて起動し直す（1 秒から倍々、上限 60 秒）
 * - 一定時間（既定 60 秒）安定して動いたら、間隔を元に戻す
 * - 停止は SIGTERM。猶予（既定 8 秒）を過ぎたら SIGKILL
 * - 子プロセスとは IPC で通信できる（'message' イベント、send()）
 *
 * イベント: 'start' (name, pid) / 'exit' (name, code, signal) / 'message' (name, msg) / 'output' (name, stream, line)
 */
class Supervisor extends EventEmitter {
    constructor(options) {
        super();

        const opts = options || {};

        this.spawnFn = opts.spawn || spawn;
        this.now = opts.now || Date.now;
        this.minBackoffMs = opts.minBackoffMs || 1000;
        this.maxBackoffMs = opts.maxBackoffMs || 60 * 1000;
        this.stableAfterMs = opts.stableAfterMs || 60 * 1000;
        this.stopTimeoutMs = opts.stopTimeoutMs || 8000;
        this.children = new Map();
    }

    /**
     * 子プロセスを登録して起動する。同じ名前がすでに動いていれば何もしない。
     * @param {string} name
     * @param {{ command: string, args?: string[], cwd?: string, env?: object }} spec
     */
    start(name, spec) {
        const existing = this.children.get(name);

        if (existing && existing.wanted) {
            existing.spec = spec;
            return;
        }

        const child = existing || {
            name,
            spec,
            process: null,
            state: 'stopped',
            restarts: 0,
            backoffMs: this.minBackoffMs,
            startedAt: null,
            lastExit: null,
            timer: null,
            wanted: false
        };

        child.spec = spec;
        child.wanted = true;
        this.children.set(name, child);
        this.launch(child);
    }

    launch(child) {
        if (!child.wanted || child.process) { return; }

        let proc;

        try {
            proc = this.spawnFn(child.spec.command, child.spec.args || [], {
                cwd: child.spec.cwd,
                env: child.spec.env || process.env,
                stdio: ['ignore', 'pipe', 'pipe', 'ipc']
            });
        } catch (err) {
            child.lastExit = { code: null, signal: null, error: err.message, at: new Date(this.now()).toISOString() };
            this.scheduleRestart(child);
            return;
        }

        child.process = proc;
        child.state = 'running';
        child.startedAt = this.now();

        for (const stream of ['stdout', 'stderr']) {
            if (proc[stream]) {
                proc[stream].setEncoding('utf8');
                proc[stream].on('data', (chunk) => {
                    for (const line of String(chunk).split('\n')) {
                        if (line !== '') { this.emit('output', child.name, stream, line); }
                    }
                });
            }
        }

        proc.on('message', (msg) => this.emit('message', child.name, msg));

        proc.on('error', (err) => {
            // spawn に失敗したときは exit が来ないことがある
            if (child.process === proc && proc.pid === undefined) {
                child.process = null;
                child.lastExit = { code: null, signal: null, error: err.message, at: new Date(this.now()).toISOString() };
                this.scheduleRestart(child);
            }
        });

        proc.on('exit', (code, signal) => {
            if (child.process !== proc) { return; }

            const ranMs = this.now() - child.startedAt;

            child.process = null;
            child.lastExit = { code, signal, at: new Date(this.now()).toISOString() };
            this.emit('exit', child.name, code, signal);

            if (child.stopResolve) {
                child.stopResolve();
                child.stopResolve = null;
            }

            if (!child.wanted) {
                child.state = 'stopped';
                return;
            }

            // 安定して動いていたなら、再起動の間隔を元に戻す
            if (ranMs >= this.stableAfterMs) {
                child.backoffMs = this.minBackoffMs;
            }

            this.scheduleRestart(child);
        });

        this.emit('start', child.name, proc.pid);
    }

    scheduleRestart(child) {
        if (!child.wanted) { return; }

        const delay = child.backoffMs;

        child.state = 'backoff';
        child.restarts++;
        child.nextStartAt = this.now() + delay;
        child.backoffMs = Math.min(child.backoffMs * 2, this.maxBackoffMs);
        child.timer = setTimeout(() => {
            child.timer = null;
            child.nextStartAt = null;
            this.launch(child);
        }, delay);
        child.timer.unref();
    }

    /** 子プロセスを止める（再起動もしない）。止まったら resolve する */
    stop(name) {
        const child = this.children.get(name);

        if (!child) { return Promise.resolve(false); }

        child.wanted = false;

        if (child.timer) {
            clearTimeout(child.timer);
            child.timer = null;
        }

        const proc = child.process;

        if (!proc) {
            child.state = 'stopped';
            return Promise.resolve(true);
        }

        child.state = 'stopping';

        return new Promise((resolve) => {
            child.stopResolve = () => resolve(true);

            try {
                proc.kill('SIGTERM');
            } catch (err) {
                // すでに終了している
            }

            const killTimer = setTimeout(() => {
                if (child.process === proc) {
                    try {
                        proc.kill('SIGKILL');
                    } catch (err) {
                        // すでに終了している
                    }
                }
            }, this.stopTimeoutMs);

            killTimer.unref();
        });
    }

    /** 止めて、登録からも外す */
    async remove(name) {
        await this.stop(name);
        this.children.delete(name);
    }

    /** 止めてから起動し直す（再起動の間隔はリセットする） */
    async restart(name) {
        const child = this.children.get(name);

        if (!child) { return false; }

        const spec = child.spec;

        await this.stop(name);
        child.backoffMs = this.minBackoffMs;
        this.start(name, spec);

        return true;
    }

    /** 名前に合う子プロセスをまとめて止める（並行して止め、全部止まったら resolve） */
    stopMatching(predicate) {
        const names = Array.from(this.children.keys()).filter(predicate);

        return Promise.all(names.map((name) => this.stop(name)));
    }

    send(name, msg) {
        const child = this.children.get(name);

        if (!child || !child.process || !child.process.connected) { return false; }

        child.process.send(msg);

        return true;
    }

    signal(name, sig) {
        const child = this.children.get(name);

        if (!child || !child.process) { return false; }

        child.process.kill(sig);

        return true;
    }

    names() {
        return Array.from(this.children.keys());
    }

    status(name) {
        const child = this.children.get(name);

        if (!child) { return null; }

        return {
            name: child.name,
            state: child.state,
            pid: child.process ? child.process.pid : null,
            restarts: child.restarts,
            startedAt: child.startedAt && child.process ? new Date(child.startedAt).toISOString() : null,
            nextStartAt: child.nextStartAt ? new Date(child.nextStartAt).toISOString() : null,
            lastExit: child.lastExit
        };
    }
}

module.exports = { Supervisor };
