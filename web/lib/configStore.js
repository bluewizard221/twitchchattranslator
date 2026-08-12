'use strict';

const paths = require('../../lib/paths');
const { readJson, writeJsonAtomic, statSafe } = require('../../lib/fileStore');
const { FIELDS, FIELD_BY_KEY, validateField } = require('./configSchema');

/**
 * node-config と同じ優先順位で設定ファイルを重ね合わせる。
 *   config/default.json  →  config/<BOT_NODE_ENV>.json  →  config/local.json
 * 後ろのファイルほど優先される。Web UI からの保存先は常に config/local.json。
 */
function layerDefinitions() {
    const layers = [
        { name: 'default.json', file: paths.DEFAULT_CONFIG, editable: false }
    ];

    const botEnv = (process.env.BOT_NODE_ENV || '').trim();

    if (botEnv && botEnv !== 'default' && botEnv !== 'local') {
        layers.push({ name: botEnv + '.json', file: paths.envConfig(botEnv), editable: false });
    }

    layers.push({ name: 'local.json', file: paths.LOCAL_CONFIG, editable: true });

    return layers;
}

function loadLayers() {
    return layerDefinitions().map((layer) => {
        const result = readJson(layer.file);
        const section = result.data && typeof result.data.config === 'object' && result.data.config !== null
            ? result.data.config
            : {};

        return {
            name: layer.name,
            file: layer.file,
            editable: layer.editable,
            missing: result.missing,
            error: result.error,
            config: section
        };
    });
}

/**
 * 各項目の実効値と、その値がどのファイル由来かを返す。
 */
function loadEffective() {
    const layers = loadLayers();
    const values = {};
    const sources = {};

    for (const layer of layers) {
        for (const field of FIELDS) {
            if (Object.prototype.hasOwnProperty.call(layer.config, field.key)) {
                const value = layer.config[field.key];

                if (value === null || value === undefined || value === '') { continue; }

                values[field.key] = value;
                sources[field.key] = layer.name;
            }
        }
    }

    return { values, sources, layers };
}

/**
 * config/default.json に同梱されている説明文（例: "配信者の数値ID"）がそのまま残っているかを判定する。
 * 実際に使う値はいずれも ASCII なので、default.json 由来かつ非 ASCII を含む値は未設定とみなす。
 * 利用者が自分で保存した値（local.json 由来）は対象にしない。
 */
function isPlaceholderValue(value, source) {
    if (source !== 'default.json') { return false; }
    if (typeof value !== 'string') { return false; }

    return /[^\x20-\x7e]/.test(value);
}

/** 未入力、またはテンプレートの説明文のままになっている必須項目の一覧 */
function incompleteRequired(values, sources) {
    return FIELDS
        .filter((field) => field.required)
        .map((field) => {
            const value = values[field.key];
            const source = sources ? sources[field.key] : null;

            if (value === undefined || value === null || value === '') {
                return { key: field.key, label: field.label, reason: '未設定' };
            }
            if (isPlaceholderValue(value, source)) {
                return { key: field.key, label: field.label, reason: 'config/default.json の説明文のまま' };
            }

            return null;
        })
        .filter((item) => item !== null);
}

/**
 * 実際に使える値だけを返す（テンプレートの説明文のままの項目は未設定として扱う）。
 */
function usableValues() {
    const { values, sources } = loadEffective();
    const out = {};

    for (const key of Object.keys(values)) {
        if (!isPlaceholderValue(values[key], sources[key])) {
            out[key] = values[key];
        }
    }

    return out;
}

/** config/local.json の中身（config セクション）を返す */
function loadLocal() {
    const result = readJson(paths.LOCAL_CONFIG);

    if (result.error) {
        throw new Error('config/local.json を読み込めません。' + result.error);
    }

    const root = result.data && typeof result.data === 'object' ? result.data : {};
    const section = root.config && typeof root.config === 'object' ? root.config : {};

    return { root, config: section };
}

/**
 * UI へ返すスナップショット。
 * secret 項目は値を返さず「設定済みかどうか」だけを返す。
 */
function snapshot() {
    const { values, sources, layers } = loadEffective();
    const out = {};

    for (const field of FIELDS) {
        const has = Object.prototype.hasOwnProperty.call(values, field.key);
        const placeholder = has && isPlaceholderValue(values[field.key], sources[field.key]);

        out[field.key] = {
            value: field.secret ? null : (has ? values[field.key] : ''),
            hasValue: has && !placeholder,
            isPlaceholder: placeholder,
            source: has ? sources[field.key] : null
        };
    }

    return {
        values: out,
        layers: layers.map((layer) => ({
            name: layer.name,
            path: relativePath(layer.file),
            missing: layer.missing,
            error: layer.error,
            editable: layer.editable,
            keys: Object.keys(layer.config).length
        }))
    };
}

/**
 * 受け取った差分を検証して config/local.json に保存する。
 * 空文字の secret 項目は「変更しない」と解釈する。
 */
function saveLocal(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, errors: { _: '保存するデータが不正です。' } };
    }

    const local = loadLocal();
    const next = Object.assign({}, local.config);
    const errors = {};
    const saved = [];

    for (const key of Object.keys(patch)) {
        const field = FIELD_BY_KEY.get(key);

        if (!field) {
            errors[key] = '未知の設定項目です。';
            continue;
        }

        const raw = patch[key];

        // secret 項目は空欄なら既存の値を保持する
        if (field.secret && (raw === null || raw === undefined || String(raw).trim() === '')) {
            continue;
        }

        // 空欄は「local.json に値があれば取り消す / なければ何もしない」と解釈する。
        // 未入力の必須項目はエラーにせず、保存後に missingRequired として知らせる。
        const isBlank = raw === null || raw === undefined || String(raw).trim() === '';

        if (isBlank) {
            if (Object.prototype.hasOwnProperty.call(local.config, key)) {
                delete next[key];
                saved.push(key);
            }
            continue;
        }

        const result = validateField(field, raw);

        if (result.error) {
            errors[key] = result.error;
            continue;
        }

        if (result.value === '' || result.value === undefined) { continue; }

        next[key] = result.value;
        saved.push(key);
    }

    if (Object.keys(errors).length > 0) {
        return { ok: false, errors: errors };
    }

    const root = Object.assign({}, local.root, { config: next });

    writeJsonAtomic(paths.LOCAL_CONFIG, root, { mode: 0o600 });

    // 保存後もまだ埋まっていない必須項目を警告として返す
    const after = loadEffective();
    const missing = incompleteRequired(after.values, after.sources)
        .map((item) => item.label + '（' + item.reason + '）');

    return { ok: true, saved: saved, missingRequired: missing };
}

function relativePath(file) {
    return file.startsWith(paths.ROOT + '/') ? file.slice(paths.ROOT.length + 1) : file;
}

/** 設定ファイルの更新日時 */
function localMeta() {
    const stat = statSafe(paths.LOCAL_CONFIG);

    return {
        path: relativePath(paths.LOCAL_CONFIG),
        exists: stat !== null,
        updatedAt: stat ? stat.mtime.toISOString() : null
    };
}

module.exports = {
    loadLayers,
    loadEffective,
    usableValues,
    loadLocal,
    snapshot,
    saveLocal,
    localMeta,
    relativePath,
    isPlaceholderValue,
    incompleteRequired
};
