#!/usr/local/bin/node

const confFile = require('config');
const log4js = require('log4js');
const { fetchEmoteNames } = require('./lib/emotes');
const lists = require('./lib/lists');

log4js.configure({
    appenders: { system: { type: 'dateFile', filename: 'logs/emotelistupdate.log', pattern: "yyyyMMdd", compress: true } },
    categories: { default: { appenders: ['system'], level: 'debug' } }
});

const logger = log4js.getLogger('system');

// ログを書き出してから終了する（log4js はバッファリングするため）
function quit(code) {
    log4js.shutdown(() => process.exit(code));
}

if (!confFile.config.twitchChannel) {
    logger.error('Twitch Channel name is not provided');
    quit(2);
} else if (!confFile.config.twitchUserId) {
    logger.error('Twitch User ID is not provided');
    quit(3);
} else {
    (async () => {
	try {
	    const result = await fetchEmoteNames({
		twitchChannel: confFile.config.twitchChannel,
		twitchUserId: confFile.config.twitchUserId
	    });

	    for (const source of result.sources) {
		if (source.ok) {
		    logger.info(source.label + ': ' + source.count + ' emote(s) fetched, ' + source.added + ' added');
		}
	    }

	    // 取得に失敗した取得元は warnings 側に含まれる
	    for (const warning of result.warnings) {
		logger.warn(warning);
	    }

	    // 全滅した場合は空の一覧で emoticons.json を上書きしない
	    if (result.sources.every((source) => !source.ok)) {
		logger.error('no emote source responded. emoticons.json is left untouched');
		return quit(5);
	    }

	    const written = lists.write('emoticons', result.names);

	    if (!written.ok) {
		logger.error('failed to write emoticons.json: ' + written.errors.join(' / '));
		return quit(4);
	    }

	    logger.info('emoticons.json updated: ' + written.items.length + ' emote(s)');
	} catch(err) {
	    logger.error(err.message);
	    console.log(err);
	    quit(1);
	}
    })();
}
