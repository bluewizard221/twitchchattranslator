'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempRoot, writeJson, readJson } = require('./helpers');

const ROOT = useTempRoot();

const paths = require('../lib/paths');
const channels = require('../lib/channels');
const migrate = require('../scripts/migrate-single-channel');

const KEY = {
    type: 'service_account',
    project_id: 'legacy-project',
    private_key: '-----BEGIN PRIVATE KEY-----\nLEGACYSECRET\n-----END PRIVATE KEY-----\n',
    client_email: 'bot@legacy-project.iam.gserviceaccount.com'
};

/** 単一チャンネル版の配置を作る（コンテナ内のパス /app/... で書かれた googleKeyFile を含む） */
function legacySetup(overrides) {
    writeJson(path.join(ROOT, 'config', 'default.json'), {
        config: Object.assign({
            pidFile: '/app/twitchchattranslator.pid',
            googleKeyFile: '/app/config/legacy-key.json',
            twitchUserName: 'old_bot',
            twitchOauth: 'oauth:legacytoken',
            twitchChannel: 'Streamer_One',
            twitchClientId: 'clientid0123456789',
            twitchClientSecret: 'legacy-client-secret',
            twitchBroadcasterId: '424242',
            twitchBotUserAccessToken: 'legacy-access',
            twitchBotRefreshToken: 'legacy-refresh',
            coolDownCount: 6
        }, overrides || {})
    });
    writeJson(path.join(ROOT, 'config', 'legacy-key.json'), KEY);
    writeJson(paths.IGNORE_USERS, { ignoreusers: ['nightbot', 'bad name!'] });
    writeJson(paths.IGNORE_LINES, { ignorelines: ['^!'] });
    writeJson(paths.EMOTICONS, { emoticons: ['Kappa', 'PogChamp'] });
}

function reset() {
    channels.removeFiles('streamer_one');
    fs.rmSync(paths.OPERATORS, { force: true });
}

test('確認だけでは何も書かない', () => {
    legacySetup();
    reset();

    const result = migrate.plan('streamer_one');

    assert.strictEqual(result.ok, true, result.errors.join());
    assert.strictEqual(result.items.broadcasterId, '424242');
    assert.strictEqual(result.items.coolDownCount, 6);
    assert.deepStrictEqual(result.items.lists.ignoreusers, ['nightbot']);
    assert.ok(result.warnings.some((w) => w.includes('bad name!')), '形式が正しくない項目は警告して除く');
    assert.strictEqual(result.items.googleKey.projectId, 'legacy-project');
    assert.strictEqual(fs.existsSync(paths.channel('streamer_one').root), false);
});

test('移すと、設定・リスト・キーがチャンネルの場所に入り、トークンは移さない', () => {
    legacySetup();
    reset();

    migrate.apply(migrate.plan('streamer_one'), { operator: true });

    const p = paths.channel('streamer_one');
    const local = readJson(p.localConfig);

    assert.deepStrictEqual(local.config, { twitchChannel: 'streamer_one', twitchBroadcasterId: '424242', coolDownCount: 6 });
    assert.deepStrictEqual(readJson(p.ignoreUsers).ignoreusers, ['nightbot']);
    assert.deepStrictEqual(readJson(p.ignoreLines).ignorelines, ['^!']);
    assert.deepStrictEqual(readJson(p.emoticons).emoticons, ['Kappa', 'PogChamp']);
    assert.strictEqual(readJson(p.googleKey).project_id, 'legacy-project');
    assert.strictEqual((fs.statSync(p.googleKey).mode & 0o777).toString(8), '600');
    assert.strictEqual(fs.existsSync(p.botTokens), false, 'bot のトークンは移さない（接続し直す）');
    assert.deepStrictEqual(readJson(paths.OPERATORS).operators, ['streamer_one']);
    assert.strictEqual(channels.get('streamer_one').createdBy, 'migration');

    // 秘密の値は channels/ の設定にも操作の記録にも書かない
    const written = JSON.stringify(readJson(p.localConfig)) + fs.readFileSync(paths.AUDIT_LOG, 'utf8');

    for (const secret of ['legacy-access', 'legacy-refresh', 'oauth:legacytoken', 'legacy-client-secret', 'LEGACYSECRET']) {
        assert.strictEqual(written.indexOf(secret), -1, secret);
    }

    // 元のファイルは残す（切り替えまで単一チャンネル版の bot が使う）
    assert.ok(fs.existsSync(paths.IGNORE_USERS));
    assert.ok(fs.existsSync(path.join(ROOT, 'config', 'legacy-key.json')));
});

test('2 回目は拒否する', () => {
    const result = migrate.plan('streamer_one');

    assert.strictEqual(result.ok, false);
    assert.throws(() => migrate.apply(result), /移行できません/);
});

test('設定の対象チャンネルと違うログイン名は拒否する', () => {
    legacySetup();
    reset();

    const result = migrate.plan('someone_else');

    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].includes('streamer_one'));
});

test('既存の運営者の一覧には追記する', () => {
    legacySetup();
    reset();
    writeJson(paths.OPERATORS, { operators: ['op_admin'], note: 'keep' });

    migrate.apply(migrate.plan('streamer_one'), { operator: true });

    assert.deepStrictEqual(readJson(paths.OPERATORS), { operators: ['op_admin', 'streamer_one'], note: 'keep' });
});

test('キーやリストがなくても移せる（あとで管理画面から入れる）', () => {
    legacySetup({ googleKeyFile: 'Google Cloudのサービス・アカウント・キーJSONファイルのファイルパス', twitchBroadcasterId: '配信者の数値ID' });
    reset();
    fs.rmSync(paths.EMOTICONS, { force: true });

    const result = migrate.plan('streamer_one');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.items.googleKey, null);
    assert.strictEqual(result.items.broadcasterId, null);

    migrate.apply(result);

    assert.strictEqual(fs.existsSync(paths.channel('streamer_one').googleKey), false);
    assert.deepStrictEqual(readJson(paths.channel('streamer_one').emoticons).emoticons, []);
});

test('途中で失敗したら作りかけのディレクトリを消す', () => {
    legacySetup();
    reset();

    const result = migrate.plan('streamer_one');

    result.items.lists.ignoreline = ['('];

    assert.throws(() => migrate.apply(result), /ignoreline/);
    assert.strictEqual(fs.existsSync(paths.channel('streamer_one').root), false);
});

test('コマンドとして: 既定は確認だけ、--apply で移す', () => {
    legacySetup();
    reset();

    const lines = [];
    const log = console.log;

    console.log = (msg) => lines.push(String(msg));

    try {
        assert.strictEqual(migrate.main(['node', 'x', 'streamer_one']), 0);
        assert.strictEqual(fs.existsSync(paths.channel('streamer_one').root), false);
        assert.strictEqual(migrate.main(['node', 'x', 'streamer_one', '--apply']), 0);
        assert.ok(channels.exists('streamer_one'));
    } finally {
        console.log = log;
    }

    const output = lines.join('\n');

    assert.ok(output.includes('bot アカウントを接続し直す'));
    assert.ok(output.includes('EventSub'), '共通の設定の不足を知らせる');
    assert.strictEqual(output.indexOf('legacy-client-secret'), -1);
});
