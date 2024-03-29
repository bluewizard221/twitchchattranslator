#!/usr/local/bin/node

const tmi = require('tmi.js');
const fs = require('fs');
const confFile = require('config');
const log4js = require('log4js');
const {Translate} = require('@google-cloud/translate').v2;

log4js.configure({
    appenders: { system: { type: 'dateFile', filename: 'logs/twitchchattranslator.log', pattern: "yyyyMMdd", compress: true } },
    categories: { default: { appenders: ['system'], level: 'debug' } }
});

const logger = log4js.getLogger('system');

if (!confFile.config.pidFile) {
    logger.error('Pidfile is not provided');
    process.exit(1);
}

if (!confFile.config.googleProjectId) {
    logger.error('googleProjectId is not provided');
    process.exit(2);
}

if (!confFile.config.googleKeyFile) {
    logger.error('googleKeyFile is not provided');
    process.exit(2);
}

if (!confFile.config.twitchUserName) {
    logger.error('twitch user_name not provided');
    process.exit(3);
}

if (!confFile.config.twitchOauth) {
    logger.error('twitch oauth token not provided');
    process.exit(4);
}

if (!confFile.config.twitchChannel) {
  logger.error('twitch channel URL not provided');
  process.exit(5);
}

if (!confFile.config.coolDownCount) {
  logger.error('max count for cool down timer not provided');
  process.exit(6);
}

chatTarget = '#' + confFile.config.twitchChannel;

// setting up ignore users list
const iuJson = './ignoreusers.json';
let ignoreUsers = JSON.parse(fs.readFileSync(iuJson, 'utf8')).ignoreusers;

if (!ignoreUsers) {
  logger.error('Ignore users list not provided');
  process.exit(7);
}

// setting up emoticons list
const emoticonJson = './emoticons.json'
let emotes = JSON.parse(fs.readFileSync(emoticonJson, 'utf8')).emoticons

if (!emotes) {
  logger.error('Emoticons list not provided')
  process.exit(8)
}

// setting up ignore line list
const ignoreLineFile = './ignoreline.json';
let ignoreLine = JSON.parse(fs.readFileSync(ignoreLineFile, 'utf8')).ignorelines;

if (!ignoreLine) {
  logger.error('Ignore Line not provided');
  process.exit(9);
}

// setting up Google Cloud Translation API
const translate = new Translate({
    projectId: confFile.config.googleProjectId,
    keyFilename: confFile.config.googleKeyFile,
});

// list categories for refresh
const listcategory = [
    'ignoreline',
    'ignoreusers',
    'emoticons'
];

// pre-compiled regex object for finding Japanese text
const jpRe = /[\u30a0-\u30ff\u3040-\u309f\u3005-\u3006\u30e0-\u9fcf]/;

// JSON for cool down timer
let coolDown = {};

fs.writeFile(confFile.config.pidFile, process.pid.toString(), (err) => {
  if (err) {
    logger.error(err);
  }
})

// setting up tmi.js
const ops = {
    identity: {
	username: confFile.config.twitchUserName,
	password: confFile.config.twitchOauth
    },
    connection: {
	reconnect: true,
	secure: true
    },
    channels: [ confFile.config.twitchChannel ]
};

const client = new tmi.Client(ops);

client.on('message', onMessageHandler);
client.on('connected', onConnectedHandler);

client.connect();

function onMessageHandler(target, context, msg, self) {
    if (self) { return; } // Ignore messages from bot

logger.info(context);

    //Remove whitespace from chat
    let line = msg.trim();

    if (isIgnoreLine(line)) { return; }

    //Command check
    if (line === '!refreshignoreuser') {
	refreshIgnoreUser(target, context);
	return;
    } else if (line === '!refreshignoreline') {
	refreshIgnoreLine(target, context);
	return;
    } else if (line === '!refreshemoticons') {
        refreshEmoticonsList(target, context);
        return;
    } else if (line.match(/^\!/)) {
	return;
    }

    if (isIgnoreUser(context)) { return; } // Ignore listed user(like bot)

    if (isSpammingUser(target, context)) { return; }

    line = removeEmoticons(line, context);

    if (line === '') { return; }

    translateMessage(chatTarget, context, line);
}

function isSpammingUser(target, context) {
    let username = context.username;
    let now = Date.now();

    if (context.mod === true || context.username == confFile.config.twitchChannel) {
	logger.info("user [" + context.username + "] is kinda modelator. I skip spamcheck..");
	return 0;
    }

    if (coolDown[username]) {
	if ((now - coolDown[username].latest) <= 60000) {
	    coolDown[username].count++;
	} else {
	    coolDown[username].count = 1;
	    coolDown[username].latest = now;
	}

	if (coolDown[username].count >= confFile.config.coolDownCount) {
	    logger.info("user [" + context.username + "] exceeded cool down threshold value");
	    return 1;
	}
    } else {
	coolDown[username] = {};
	coolDown[username].count = 1;
	coolDown[username].latest = now;
    }

    return 0;
}

function isIgnoreLine(line) {
    let match = 0;
    let i = 0;

    for (i = 0; i < ignoreLine.length; i++) {
	let regex = new RegExp(ignoreLine[i]);

	if (line.match(regex)) {
	    logger.info("line matched ignore rule. line [" + line + "], rule [" + regex + "]");
	    match = 1;
	    break;
	}
    }

    return match;
}

function refreshList(category) {
    let i = listcategory.indexOf(category);
    let target = '#' + confFile.config.twitchChannel;

    switch (i) {
	case 0:
	    // ignoreline
	    ignoreLine = '';
	    ignoreLine = JSON.parse(fs.readFileSync(ignoreLineFile, 'utf8')).ignorelines;

	    if (!ignoreLine) {
		logger.error("ERROR: can't reload " + ignoreLineFile);
		client.say(target, "/me ERROR: can't reload ignoring line list");
	    } else {
		logger.info("ignoring user list has been reloaded from " + ignoreLineFile);
		client.say(target, '/me ignoring line list has been reloaded from json file');
	    }

	    break;

	case 1:
	    // ignoreusers
	    ignoreUsers = '';
	    ignoreUsers = JSON.parse(fs.readFileSync(iuJson, 'utf8')).ignoreusers;

	    if (!ignoreUsers) {
		logger.error("ERROR: can't reload " + iuJson);
		client.say(target, "/me ERROR: can't reload ignoring user list");
	    } else {
		logger.info("ignoring user list has been reloaded from " + iuJson);
		client.say(target, '/me ignoring user list has been reloaded from json file');
	    }

	    break;

        case 2:
	    // emoticons
	    emotes = '';
	    emotes = JSON.parse(fs.readFileSync(emoticonJson, 'utf8')).emoticons;

	     if (!emotes) {
		logger.error("ERROR: can't reload " + emoticonJson);
		client.say(target, "/me ERROR: can't reload emoticons user list");
	    } else {
		logger.info("emoticons list has been reloaded from " + emoticonJson);
		client.say(target, '/me emoticons list has been reloaded from json file');
	     }

	    break;

	default:
	    // error
	    logger.error("ERROR: invalid category(refreshlist) [category] " + category);
    }

    return;
}

function refreshIgnoreUser(target, context) {
    if (context.mod === false && context.username !== confFile.config.twitchChannel) { return; }

    refreshList('ignoreusers');

    return;
}

function refreshIgnoreLine(target, context) {
    if (context.mod === false && context.username !== confFile.config.twitchChannel) { return; }

    refreshList('ignoreline');

    return;
}

function refreshEmoticonsList(target, context) {
    if (context.mod === false && context.username !== twitchChannel) { return; }

    refreshList('emoticons');

    return;
}

function isIgnoreUser(context) {
    if (ignoreUsers.indexOf(context.username) !== -1) {
	return 1;
    } else {
	return 0;
    }
}


/* I refered https://www.stefanjudis.com/blog/how-to-display-twitch-emotes-in-tmi-js-chat-messages/
 * to implement this.
 * thanks a lot...!
 */
function removeEmoticons(line, context) {
    if (!context.emotes) {
	// removing BTTV/FFZ emotes
	return removeThirdpartyEmotes(line);
    }

    // removing twitch channel/global emotes
    const replaceSource = [];

    Object.entries(context.emotes).forEach(([id, offsets]) => {
	const offset = offsets[0];
	const [start, end] = offset.split('-');
	const stringToReplace = line.substring(
	    parseInt(start, 10),
	    parseInt(end, 10) + 1
	);

	replaceSource.push({ stringToReplace });
    });

    const twresult = replaceSource.reduce(
	(tmp, { stringToReplace }) => {
	    return tmp.split(stringToReplace).join('');
	},
	line
    );

    const regex = new RegExp('^ +$');

    if (twresult.match(regex)) {
	return '';
    }

    // removing BTTV/FFZ emotes
    return removeThirdpartyEmotes(twresult);
}

function removeThirdpartyEmotes(line) {
    let search = line.split(' ');
    let i = emotes.length;

    while (i--) {
	let index = search.indexOf(emotes[i]);

	while (index !== -1) {
	    search.splice(index, 1);
	    index = search.indexOf(emotes[i]);
	}
    }

    return search.join(' ');
}

async function translateMessage(target, context, line) {
    let toLang = 'ja';

    if (jpRe.exec(line)) {
	toLang = 'en';
    } else {
	toLang = 'ja';
    }

//    logger.info('DEBUG: line [' + line + '] toLang [' + toLang + ']')

    let [detections] = await translate.detect(line);
    detections = Array.isArray(detections) ? detections : [detections];

    let fromLang = '';

    detections.forEach((detection, i) => {
	fromLang = detection.language;
    });

    let [translations] = await translate.translate(line, toLang);
    translations = Array.isArray(translations) ? translations : [translations];

    translations.forEach((translation, i) => {
	client.say(target, '/me ' + translation + '(source lang: ' + fromLang + ')');
    });
}

function onConnectedHandler(addr, port) {
    logger.info('Connected to twitch chat channel [' + addr + ':' + port + ']');
}

process.on('SIGINT', () => {
    logger.info('SIGINT caught. shutting down...');

    process.exit(0);
})

process.on('SIGHUP', () => {
    logger.info('SIGHUP caught. refreshing database...');

    refreshList('ignoreusers');
    refreshList('ignoreline');
    refreshList('emoticons');
})
