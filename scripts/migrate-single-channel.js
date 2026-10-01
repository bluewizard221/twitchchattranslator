#!/usr/bin/env node
'use strict';

/**
 * 単一チャンネル版の設定を、複数チャンネル版の channels/<login>/ に移す（仕様書 14 節の段階 C）。
 *
 *   node scripts/migrate-single-channel.js <login>                 何をするかを表示するだけ（何も書かない）
 *   node scripts/migrate-single-channel.js <login> --apply         実際に移す
 *   node scripts/migrate-single-channel.js <login> --apply --operator   あわせて運営者にする
 *
 * 移すもの:
 *   - 対象チャンネル・配信者の ID・クールダウン（config/default.json → local.json の順に重ねた値）
 *   - 翻訳しないユーザー・文字列・エモート（ルートの ignoreusers.json / ignoreline.json / emoticons.json）
 *   - Google Cloud のキー（googleKeyFile のファイル → channels/<login>/secrets/google-key.json、0600）
 *
 * 移さないもの:
 *   - bot アカウントのトークン（twitchBotUserAccessToken など）。EventSub の受信に要る user:read:chat の許可が
 *     ないため、移行後に配信者が管理画面から bot アカウントを接続し直す
 *   - 元のファイル。単一チャンネル版の bot が切り替えまで使うので、消さずに残す（後片付けは段階 D）
 *
 * 秘密の値は表示しない。設定の読み書きはコンテナと同じ uid（1000）で行うこと（ホストの wizard でよい）。
 */

const fs = require('fs');
const path = require('path');
const paths = require('../lib/paths');
const channels = require('../lib/channels');
const lists = require('../lib/lists');
const audit = require('../lib/audit');
const sharedConfig = require('../lib/sharedConfig');
const { readJson, writeJsonAtomic } = require('../lib/fileStore');
const googleKey = require('../web/lib/googleKey');

/** config/default.json → config/local.json の順に重ねた config セクション */
function legacyConfig() {
    const merged = {};
    const errors = [];

    for (const file of [paths.DEFAULT_CONFIG, paths.LOCAL_CONFIG]) {
        const result = readJson(file);

        if (result.error) { errors.push(path.relative(paths.ROOT, file) + ': ' + result.error); }
        if (result.data && result.data.config && typeof result.data.config === 'object') {
            Object.assign(merged, result.data.config);
        }
    }

    return { config: merged, errors };
}

/**
 * キーファイルのパスを、このディレクトリ（paths.ROOT）の中で解決する。
 * コンテナでは /app/config/... と書かれているので、ホストで動かすときは /app を paths.ROOT に読み替える。
 */
function resolveKeyFile(value) {
    if (typeof value !== 'string' || value.trim() === '' || /[^\x20-\x7e]/.test(value)) { return null; }

    const raw = value.trim();
    const candidates = [];

    if (path.isAbsolute(raw)) {
        candidates.push(raw);
        if (raw.startsWith('/app/')) { candidates.push(path.join(paths.ROOT, raw.slice('/app/'.length))); }
    } else {
        candidates.push(path.join(paths.ROOT, raw));
    }

    return candidates.find((file) => fs.existsSync(file)) || null;
}

/**
 * 何を移すかを調べる（何も書かない）。
 * @returns {{ ok: boolean, login, errors: string[], warnings: string[], items: object }}
 */
function plan(loginArg) {
    const login = channels.normalize(loginArg);
    const errors = [];
    const warnings = [];
    const items = { login, broadcasterId: null, coolDownCount: null, lists: {}, googleKey: null };

    if (!paths.isValidLogin(login)) {
        errors.push('Twitch のログイン名の形式が正しくありません: ' + loginArg);
        return { ok: false, login, errors, warnings, items };
    }
    if (fs.existsSync(paths.channel(login).root)) {
        errors.push('channels/' + login + '/ はすでにあります。移行は 1 回だけ行います（やり直す場合は、管理画面からチャンネルを削除してから）。');
    }

    const legacy = legacyConfig();

    errors.push(...legacy.errors);

    const config = legacy.config;
    const channel = typeof config.twitchChannel === 'string' ? channels.normalize(config.twitchChannel) : '';

    // 別のチャンネルの設定を移さない（他人のチャンネルに投稿しないため）
    if (paths.isValidLogin(channel) && channel !== login) {
        errors.push('設定の対象チャンネル（' + channel + '）と、指定したログイン名（' + login + '）が違います。');
    } else if (!paths.isValidLogin(channel)) {
        warnings.push('設定に対象チャンネル（twitchChannel）がありません。指定したログイン名で登録します。');
    }

    if (/^\d+$/.test(String(config.twitchBroadcasterId || ''))) {
        items.broadcasterId = String(config.twitchBroadcasterId);
    } else {
        warnings.push('配信者の ID（twitchBroadcasterId）がありません。配信者が管理画面にログインしたときに記録されます。');
    }

    const cooldown = Number(config.coolDownCount);

    if (Number.isInteger(cooldown) && cooldown >= 1 && cooldown <= 1000) {
        items.coolDownCount = cooldown;
    } else if (config.coolDownCount !== undefined) {
        warnings.push('クールダウン回数（coolDownCount）が範囲外のため移しません（既定値 5 になります）。');
    }

    for (const def of lists.describeAll()) {
        const data = lists.read(def.id);

        if (data.error) {
            warnings.push(def.label + '（' + path.relative(paths.ROOT, def.path) + '）を読めないため移しません: ' + data.error);
            continue;
        }

        // 今の検証を通らない項目は移さない（以前の版では検証せずに書けたため）
        const validate = lists.getList(def.id).validate;
        const invalid = data.items.filter((item) => validate && validate(String(item).trim()) !== null);

        if (invalid.length > 0) {
            warnings.push(def.label + ' の ' + invalid.length + ' 件は形式が正しくないため移しません: ' + invalid.slice(0, 5).join(', '));
        }

        items.lists[def.id] = data.items.filter((item) => invalid.indexOf(item) === -1);
    }

    const keyFile = resolveKeyFile(config.googleKeyFile);

    if (!keyFile) {
        warnings.push('Google Cloud のキー（googleKeyFile）が見つかりません。配信者が管理画面からアップロードします。');
    } else {
        const validated = googleKey.validateKeyContent(fs.readFileSync(keyFile, 'utf8'));

        if (validated.ok) {
            items.googleKey = { file: keyFile, projectId: validated.key.project_id, clientEmail: validated.key.client_email };
        } else {
            warnings.push('Google Cloud のキー（' + path.relative(paths.ROOT, keyFile) + '）を移せません: ' + validated.error);
        }
    }

    return { ok: errors.length === 0, login, errors, warnings, items };
}

/** plan() の内容で channels/<login>/ を作る */
function apply(result, options) {
    const opts = options || {};
    const login = result.login;
    const items = result.items;

    if (!result.ok) { throw new Error('移行できません: ' + result.errors.join(' / ')); }

    const created = channels.create(login, { createdBy: 'migration' });

    if (!created.ok) { throw new Error(created.error); }

    // 途中で失敗したら作りかけのディレクトリを消し、やり直せるようにする
    try {
        return fill(login, items, opts);
    } catch (err) {
        channels.removeFiles(login);
        throw err;
    }
}

function fill(login, items, opts) {
    const p = paths.channel(login);
    const local = readJson(p.localConfig).data;

    if (items.broadcasterId) { local.config.twitchBroadcasterId = items.broadcasterId; }
    if (items.coolDownCount !== null) { local.config.coolDownCount = items.coolDownCount; }

    writeJsonAtomic(p.localConfig, local, { mode: 0o600, backup: false });

    const store = lists.forChannel(login);
    const counts = {};

    for (const id of Object.keys(items.lists)) {
        const written = store.write(id, items.lists[id]);

        if (!written.ok) { throw new Error(id + ' を書き込めません: ' + written.errors.join(' / ')); }
        counts[id] = written.items.length;
    }

    if (items.googleKey) {
        const saved = googleKey.saveForChannel(login, fs.readFileSync(items.googleKey.file, 'utf8'));

        if (!saved.ok) { throw new Error('Google Cloud のキーを保存できません: ' + saved.error); }
    }

    if (opts.operator) {
        const current = readJson(paths.OPERATORS);
        const root = current.data && typeof current.data === 'object' && !Array.isArray(current.data) ? current.data : {};
        const operators = Array.isArray(root.operators) ? root.operators.slice() : [];

        if (operators.indexOf(login) === -1) { operators.push(login); }

        writeJsonAtomic(paths.OPERATORS, Object.assign({}, root, { operators }), { mode: 0o640 });
    }

    audit.append({
        actor: 'migration',
        action: 'channel.migrate',
        channel: login,
        detail: { lists: counts, googleKey: !!items.googleKey, broadcasterId: !!items.broadcasterId, operator: !!opts.operator }
    });

    return { counts };
}

/** 移行後に残る作業（共通の設定の不足と、配信者が管理画面で行うこと） */
function remaining(login) {
    const shared = sharedConfig.load();
    const todo = [];

    if (!shared.twitchClientId || !shared.twitchClientSecret) {
        todo.push('共通の設定: Twitch アプリの Client ID / Secret（config/default.json または config/local.json）');
    }
    if (!shared.eventsubCallbackUrl || !shared.eventsubSecret) {
        todo.push('共通の設定: EventSub の受信口の URL と署名用シークレット（config/local.json の config.eventsub.callbackUrl / secret、または管理画面の「共通の設定」）');
    }

    todo.push(login + ' が管理画面にログインし、channel:bot を許可する');
    todo.push(login + ' が管理画面の「マイチャンネル」から bot アカウントを接続し直す（以前のトークンは移していません）');
    todo.push('起動コマンドを node manager.js に変え、ホストの cron のエモート更新を外す');

    return todo;
}

function main(argv) {
    const args = argv.slice(2);
    const login = args.find((a) => !a.startsWith('--'));
    const doApply = args.indexOf('--apply') !== -1;
    const operator = args.indexOf('--operator') !== -1;

    if (!login) {
        console.error('使い方: node scripts/migrate-single-channel.js <login> [--apply] [--operator]');
        return 2;
    }

    const result = plan(login);
    const items = result.items;

    console.log('対象ディレクトリ: ' + paths.ROOT);
    console.log('チャンネル: ' + result.login + (operator ? '（運営者にもする）' : ''));
    console.log('  配信者の ID: ' + (items.broadcasterId ? 'あり' : 'なし'));
    console.log('  クールダウン回数: ' + (items.coolDownCount !== null ? items.coolDownCount : '既定値'));

    for (const id of Object.keys(items.lists)) {
        console.log('  リスト ' + id + ': ' + items.lists[id].length + ' 件');
    }

    console.log('  Google Cloud のキー: ' + (items.googleKey
        ? path.relative(paths.ROOT, items.googleKey.file) + '（プロジェクト ' + items.googleKey.projectId + '）→ channels/' + result.login + '/secrets/google-key.json'
        : 'なし'));

    for (const warning of result.warnings) { console.log('注意: ' + warning); }
    for (const error of result.errors) { console.error('エラー: ' + error); }

    if (!result.ok) { return 1; }

    if (!doApply) {
        console.log('\n確認だけ行いました（何も書き込んでいません）。移す場合は --apply を付けて実行してください。');
        return 0;
    }

    apply(result, { operator });
    console.log('\nchannels/' + result.login + '/ を作成しました。元のファイルはそのまま残しています。');
    console.log('残りの作業:');
    remaining(result.login).forEach((item, i) => console.log('  ' + (i + 1) + '. ' + item));

    return 0;
}

if (require.main === module) {
    process.exitCode = main(process.argv);
}

module.exports = { plan, apply, remaining, resolveKeyFile, main };
