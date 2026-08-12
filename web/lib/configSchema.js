'use strict';

/**
 * config/default.json の config セクションで bot が参照する項目の定義。
 * label / help は日本語 UI にそのまま表示される。
 *
 *   type   : 'text' | 'password' | 'number' | 'path'
 *   secret : true の場合、値をブラウザへ送らず「設定済み」の有無だけを返す
 *   oauth  : Twitch ログイン情報から自動入力できる項目（'login' = チャンネル名 / 'id' = 数値 ID）
 */
const FIELDS = [
    {
        key: 'pidFile',
        label: 'PID ファイル',
        type: 'path',
        group: 'bot',
        required: true,
        placeholder: '/var/run/twitchchattranslator.pid',
        help: 'bot がプロセス ID を書き出すファイルのパス。設定の再読み込み（SIGHUP）にも使用します。'
    },
    {
        key: 'twitchUserName',
        label: 'bot のユーザー名',
        type: 'text',
        group: 'bot',
        required: true,
        placeholder: 'my_translator_bot',
        help: '翻訳 bot として発言するアカウントのユーザー名（表示名ではなくアルファベットの方）。'
    },
    {
        key: 'twitchOauth',
        label: 'bot の OAuth トークン',
        type: 'password',
        group: 'bot',
        secret: true,
        required: true,
        placeholder: 'oauth:xxxxxxxxxxxxxxxx',
        help: 'IRC 接続用のトークン。https://twitchapps.com/tmi/ で取得できます（oauth: から始まる文字列）。'
    },
    {
        key: 'twitchChannel',
        label: '対象チャンネル名',
        type: 'text',
        group: 'channel',
        required: true,
        oauth: 'login',
        pattern: /^[a-zA-Z0-9_]{3,25}$/,
        patternHelp: '半角英数字とアンダースコアのみ、3〜25 文字で入力してください。',
        placeholder: 'my_channel',
        help: '翻訳 bot を動かすチャンネル名（表示名ではなくアルファベットの方）。ログイン中の Twitch アカウントから自動入力できます。'
    },
    {
        key: 'twitchBroadcasterId',
        label: '配信者のユーザー ID',
        type: 'text',
        group: 'channel',
        required: true,
        oauth: 'id',
        pattern: /^[0-9]{1,20}$/,
        patternHelp: '数字のみで入力してください。',
        placeholder: '123456789',
        help: '配信チャンネル所有者の数値 ID。ログイン中の Twitch アカウントから自動入力できます。'
    },
    {
        key: 'twitchClientId',
        label: 'アプリの Client ID',
        type: 'text',
        group: 'app',
        required: true,
        placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        help: 'Twitch Developer Console で登録したアプリケーションの Client ID。'
    },
    {
        key: 'twitchClientSecret',
        label: 'アプリの Client Secret',
        type: 'password',
        group: 'app',
        secret: true,
        required: true,
        help: '同じアプリケーションのクライアントシークレット。発行時にしか表示されないため控えを保管してください。'
    },
    {
        key: 'twitchBotUserId',
        label: 'bot のユーザー ID',
        type: 'text',
        group: 'bot',
        required: true,
        pattern: /^[0-9]{1,20}$/,
        patternHelp: '数字のみで入力してください。',
        placeholder: '987654321',
        help: '翻訳 bot アカウントの数値 ID。Helix API での発言およびメッセージ削除に使用します。'
    },
    {
        key: 'twitchBotUserAccessToken',
        label: 'bot の User Access Token',
        type: 'password',
        group: 'bot',
        secret: true,
        required: true,
        help: 'メッセージ削除に必要な bot ユーザーのアクセストークン（moderator:manage:chat_messages スコープ）。'
    },
    {
        key: 'twitchBotRefreshToken',
        label: 'bot の Refresh Token',
        type: 'password',
        group: 'bot',
        secret: true,
        required: true,
        help: 'アクセストークンの有効期限が切れた際に自動更新するためのリフレッシュトークン。'
    },
    {
        key: 'googleProjectId',
        label: 'Google Cloud プロジェクト ID',
        type: 'text',
        group: 'google',
        required: true,
        placeholder: 'my-gcp-project',
        help: 'Cloud Translation API を有効にしたプロジェクトの ID。サービスアカウントキーをアップロードすると自動入力されます。'
    },
    {
        key: 'googleKeyFile',
        label: 'サービスアカウントキーのパス',
        type: 'path',
        group: 'google',
        required: true,
        placeholder: 'config/google-key.json',
        help: 'Google Cloud のサービスアカウントキー（JSON）のファイルパス。「Google Cloud キー」タブからアップロードできます。'
    },
    {
        key: 'coolDownCount',
        label: 'クールダウン回数',
        type: 'number',
        group: 'behavior',
        required: true,
        min: 1,
        max: 1000,
        help: '同一ユーザーから 1 分間に受け付ける最大翻訳回数。これを超えた発言は翻訳されません。'
    }
];

const GROUPS = [
    { key: 'bot', label: '翻訳 bot アカウント', help: 'チャットに翻訳を投稿する bot アカウントの設定です。' },
    { key: 'channel', label: '対象チャンネル', help: 'Twitch ログイン情報から自動入力できます。' },
    { key: 'app', label: 'Twitch アプリケーション', help: 'Twitch Developer Console で登録したアプリの認証情報です。' },
    { key: 'google', label: 'Google Cloud Translation', help: '翻訳 API に接続するための設定です。' },
    { key: 'behavior', label: '動作設定', help: '翻訳の挙動に関する設定です。' }
];

const FIELD_BY_KEY = new Map(FIELDS.map((field) => [field.key, field]));

/**
 * 1 項目分の入力値を検証し、保存すべき値に正規化する。
 * @returns {{ value?: *, error?: string }}
 */
function validateField(field, rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') {
        if (field.required) {
            return { error: field.label + 'は必須項目です。' };
        }
        return { value: '' };
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
    if (field.pattern && !field.pattern.test(value)) {
        return { error: field.label + 'の形式が正しくありません。' + (field.patternHelp || '') };
    }

    return { value: value };
}

/** ブラウザへ渡すためのフィールド定義（正規表現などは文字列化する） */
function publicFields() {
    return FIELDS.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        group: field.group,
        secret: !!field.secret,
        required: !!field.required,
        oauth: field.oauth || null,
        placeholder: field.placeholder || '',
        help: field.help || ''
    }));
}

module.exports = { FIELDS, GROUPS, FIELD_BY_KEY, validateField, publicFields };
