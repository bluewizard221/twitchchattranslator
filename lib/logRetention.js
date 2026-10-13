'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 古いログの削除（D19: bot と管理画面のログは 30 日）。
 * log4js の dateFile は当日分を *.log、過去分を *.log.YYYYMMDD(.gz) に切り替えるので、
 * 過去分のうち更新日時が保存期間を過ぎたものだけを消す。当日分（*.log）は消さない。
 *
 * @param {string} dir ログのディレクトリ
 * @param {number} days 保存日数
 * @returns {string[]} 削除したファイル名
 */
function pruneDir(dir, days, now) {
    const limit = (now || Date.now()) - days * 24 * 60 * 60 * 1000;
    const removed = [];
    let entries;

    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        if (err.code === 'ENOENT') { return removed; }
        throw err;
    }

    for (const entry of entries) {
        if (!entry.isFile() || !/\.log\.\d{8}(\.gz)?$/.test(entry.name)) { continue; }

        const file = path.join(dir, entry.name);

        try {
            if (fs.statSync(file).mtimeMs < limit) {
                fs.unlinkSync(file);
                removed.push(entry.name);
            }
        } catch (err) {
            // 消せないファイルは次回に回す
        }
    }

    return removed;
}

module.exports = { pruneDir };
