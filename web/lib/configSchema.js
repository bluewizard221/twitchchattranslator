'use strict';

/**
 * 管理画面で編集できる設定の定義（複数チャンネル対応版）。
 *
 * - CHANNEL_FIELDS: 配信者が自分のチャンネルについて編集する項目（channels/<login>/config/local.json）
 * - SHARED_FIELDS:  運営者が編集する共通の項目（config/local.json）
 *
 * 対象チャンネル（twitchChannel）と配信者の ID（twitchBroadcasterId）は編集させない。
 * 登録時と配信者のログイン時に、ログイン名と Twitch の ID から自動で記録する。
 * bot アカウントは OAuth 接続、GCP のキーはアップロードで設定するので、ここには含めない。
 *
 *   type   : 'text' | 'password' | 'number' | 'url'
 *   secret : true の場合、値をブラウザへ返さず「設定済み」かどうかだけを返す（書き込み専用）
 */

const CHANNEL_FIELDS = [
    {
        key: 'coolDownCount',
        label: 'クールダウン回数',
        type: 'number',
        required: true,
        min: 1,
        max: 1000,
        default: 5,
        help: '同一ユーザーの発言を 1 分間に何回目まで翻訳するか（この回数に達した発言から翻訳しません）。モデレーターとチャンネル主は対象外です。'
    },
    {
        key: 'dailyCharLimit',
        label: '1 日の翻訳文字数の上限',
        type: 'number',
        required: false,
        min: 0,
        max: 100000000,
        default: 0,
        help: 'Google に送る文字数の 1 日の上限です（言語の判定と翻訳の両方を数えます）。超えたらその日は翻訳しません。0 または空欄で上限なし。'
    }
];

const SHARED_FIELDS = [
    {
        key: 'twitchClientId',
        label: 'Twitch アプリの Client ID',
        type: 'text',
        required: true,
        pattern: /^[a-z0-9]{10,64}$/,
        patternHelp: '半角英小文字と数字で入力してください。',
        help: 'Twitch Developer Console で登録したアプリの Client ID。ログイン・bot の接続・EventSub のすべてに使います。'
    },
    {
        key: 'twitchClientSecret',
        label: 'Twitch アプリの Client Secret',
        type: 'password',
        secret: true,
        required: true,
        help: '同じアプリのクライアントシークレット。'
    },
    {
        key: 'eventsubCallbackUrl',
        label: 'EventSub の受信口の URL',
        type: 'url',
        required: true,
        // ホスト名に ":ポート" を含めさせない（443 の明示だけは許す）
        pattern: /^https:\/\/[A-Za-z0-9.-]+(:443)?\/eventsub\/callback$/,
        patternHelp: 'https://<ドメイン>/eventsub/callback の形で入力してください（Twitch の条件で 443 番の HTTPS のみ）。',
        placeholder: 'https://translate.bwscar221.site/eventsub/callback',
        help: 'Twitch がチャットのイベントを送ってくる URL です。'
    },
    {
        key: 'eventsubSecret',
        label: 'EventSub の署名用シークレット',
        type: 'password',
        secret: true,
        required: true,
        minLength: 10,
        maxLength: 100,
        help: '受け取ったイベントの署名の検証に使う、10〜100 文字のランダムな文字列（例: openssl rand -hex 32）。'
    }
];

/**
 * 1 項目分の入力値を検証し、保存すべき値に正規化する。
 * @returns {{ value?: *, error?: string }}
 */
function validateField(field, rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') {
        return field.required ? { error: field.label + 'は必須項目です。' } : { value: '' };
    }

    if (field.type === 'number') {
        const num = typeof rawValue === 'number' ? rawValue : Number(String(rawValue).trim());

        if (!Number.isFinite(num) || !Number.isInteger(num)) {
            return { error: field.label + 'は整数で入力してください。' };
        }
        if (field.min !== undefined && num < field.min) {
            return { error: field.label + 'は ' + field.min + ' 以上で入力してください。' };
        }
        if (field.max !== undefined && num > field.max) {
            return { error: field.label + 'は ' + field.max + ' 以下で入力してください。' };
        }

        return { value: num };
    }

    if (typeof rawValue !== 'string') {
        return { error: field.label + 'は文字列で入力してください。' };
    }

    const value = rawValue.trim();

    if (value.length > 4096) {
        return { error: field.label + 'が長すぎます（4096 文字以内）。' };
    }
    if (value.indexOf('\0') !== -1 || /[\r\n]/.test(value)) {
        return { error: field.label + 'に改行や制御文字は使用できません。' };
    }
    if (/[^\x20-\x7e]/.test(value)) {
        return { error: field.label + 'は半角英数字と記号で入力してください。' };
    }
    if (field.minLength !== undefined && value.length < field.minLength) {
        return { error: field.label + 'は ' + field.minLength + ' 文字以上にしてください。' };
    }
    if (field.maxLength !== undefined && value.length > field.maxLength) {
        return { error: field.label + 'は ' + field.maxLength + ' 文字以内にしてください。' };
    }
    if (field.pattern && !field.pattern.test(value)) {
        return { error: field.label + 'の形式が正しくありません。' + (field.patternHelp || '') };
    }

    return { value };
}

/** ブラウザへ渡すためのフィールド定義（正規表現などは渡さない） */
function publicFields(fields) {
    return fields.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        secret: !!field.secret,
        required: !!field.required,
        min: field.min,
        max: field.max,
        placeholder: field.placeholder || '',
        help: field.help || ''
    }));
}

module.exports = { CHANNEL_FIELDS, SHARED_FIELDS, validateField, publicFields };
