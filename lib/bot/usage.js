'use strict';

const paths = require('../paths');
const { readJson, writeJsonAtomic } = require('../fileStore');
const path = require('path');

/**
 * 翻訳 API の使用量（D23）。Google に送った文字数を、日ごと・月ごとに数える。
 * 言語の判定（detect）と翻訳（translate）の両方で課金されるので、両方の文字数を足す。
 * ファイルは data/usage/<login>.json。書くのはそのチャンネルの bot だけ（取り合いは起きない）。
 */

const KEEP_DAYS = 62;
const KEEP_MONTHS = 13;

function localDate(ms) {
    // コンテナの TZ（Asia/Tokyo）での日付。sv-SE は YYYY-MM-DD 形式になる
    return new Date(ms).toLocaleDateString('sv-SE');
}

class Usage {
    constructor(login, options) {
        const opts = options || {};

        this.file = path.join(paths.USAGE_DIR, login + '.json');
        this.now = opts.now || Date.now;
        this.data = this.load();
    }

    load() {
        const result = readJson(this.file);
        const data = result.data && typeof result.data === 'object' ? result.data : {};

        return { days: data.days || {}, months: data.months || {} };
    }

    today() {
        return this.data.days[localDate(this.now())] || 0;
    }

    month() {
        return this.data.months[localDate(this.now()).slice(0, 7)] || 0;
    }

    /** 1 日の上限（0 は上限なし）を超えているか */
    exceeded(dailyLimit) {
        return Number(dailyLimit) > 0 && this.today() >= Number(dailyLimit);
    }

    add(chars) {
        const day = localDate(this.now());
        const month = day.slice(0, 7);

        this.data.days[day] = (this.data.days[day] || 0) + chars;
        this.data.months[month] = (this.data.months[month] || 0) + chars;

        for (const key of Object.keys(this.data.days).sort().slice(0, -KEEP_DAYS)) { delete this.data.days[key]; }
        for (const key of Object.keys(this.data.months).sort().slice(0, -KEEP_MONTHS)) { delete this.data.months[key]; }

        writeJsonAtomic(this.file, this.data, { mode: 0o640, backup: false });
    }
}

/** 管理画面などから読むとき */
function read(login, now) {
    return new Usage(login, { now });
}

module.exports = { Usage, read, localDate };
