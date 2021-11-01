#!/usr/local/bin/node

const fs = require('fs');
const confFile = require('config');
const log4js = require('log4js');
const got = require('got');

log4js.configure({
    appenders: { system: { type: 'dateFile', filename: 'logs/emotelistupdate.log', pattern: "yyyyMMdd", compress: true } },
    categories: { default: { appenders: ['system'], level: 'debug' } }
});

const logger = log4js.getLogger('system');

if (!confFile.config.twitchChannel) {
    logger.error('Twitch Channel name is not provided');
    process.exit(2);
}

if (!confFile.config.twitchUserId) {
    logger.error('Twitch User ID is not provided');
    process.exit(3);
}

const emoticonFile = './emoticons.json';

var emoticons = [];

(async () => {
    try {
	let response;
	let parsed;
	let i;
	let setid;

	// BTTV global
	response = await got('https://api.betterttv.net/3/cached/emotes/global');
	parsed = JSON.parse(response.body);
	i = parsed.length;

	while (i--) {
	    emoticons.push(parsed[i].code);
	}

	logger.info('BTTV emoticons(global) list updated');


	// BTTV channel
	response = await got('https://api.betterttv.net/3/cached/users/twitch/' + confFile.config.twitchUserId);
	parsed = JSON.parse(response.body);
	i = parsed.sharedEmotes.length;

	while (i--) {
	    emoticons.push(parsed.sharedEmotes[i].code);
	}

	logger.info('BTTV emoticons(channel) list updated');

	i = parsed.sharedEmotes.length;

	while (i--) {
	    emoticons.push(parsed.sharedEmotes[i].code);
	}

	logger.info('BTTV emoticons(shared) list updated');

	// FFZ userroom
	response = await got('https://api.frankerfacez.com/v1/room/' + confFile.config.twitchChannel);
	parsed = JSON.parse(response.body);
	setid = parsed.room.set;
	i = parsed.sets[setid].emoticons.length;

	while (i--) {
	    emoticons.push(parsed.sets[setid].emoticons[i].name);
	}

	logger.info('FFZ emoticons(userroom) list updated');


	// FFZ(global)
	response = await got('https://api.frankerfacez.com/v1/set/global');
	parsed = JSON.parse(response.body);
	setid = parsed.default_sets;
	i = parsed.sets[setid].emoticons.length;

	while (i--) {
	    emoticons.push(parsed.sets[setid].emoticons[i].name);
	}

	logger.info('FFZ emoticons(global) list updated');

	result = { "emoticons": emoticons };
	fs.writeFileSync(emoticonFile, JSON.stringify(result));
    } catch(err) {
	console.log(err);
    }
})();
