'use strict';

// テスト用の子プロセス。FAKE_MODE で振る舞いを変える。
//   run      : 動き続ける。SIGTERM で終了 0。SIGHUP を受けたら IPC で 'hup' を送る
//   crash    : すぐに終了 1
//   stubborn : SIGTERM を無視する（SIGKILL でしか止まらない）
//   config   : node-config で読んだ config を IPC で送ってから動き続ける
const mode = process.env.FAKE_MODE || 'run';

if (mode === 'crash') {
    process.exit(1);
}

if (mode === 'stubborn') {
    process.on('SIGTERM', () => {});
}

if (mode === 'run' || mode === 'config') {
    process.on('SIGTERM', () => process.exit(0));
}

process.on('SIGHUP', () => {
    if (process.send) { process.send({ type: 'hup', name: process.env.TCT_CHANNEL || null }); }
});

process.on('message', (msg) => {
    if (msg && msg.type === 'ping' && process.send) {
        process.send({ type: 'pong', cwd: process.cwd(), channel: process.env.TCT_CHANNEL || null });
    }
});

if (mode === 'config' && process.send) {
    const config = require('config');

    process.send({ type: 'config', config: config.get('config') });
}

setInterval(() => {}, 1000);
