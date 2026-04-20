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

if (!confFile.config.twitchClientId) {
  logger.error('twitch client_id not provided');
  process.exit(7);
}

if (!confFile.config.twitchClientSecret) {
  logger.error('twitch client_secret not provided');
  process.exit(8);
}

if (!confFile.config.twitchBotUserId) {
  logger.error('twitch bot user_id not provided');
  process.exit(9);
}

if (!confFile.config.twitchBroadcasterId) {
  logger.error('twitch broadcaster_id not provided');
  process.exit(10);
}

if (!confFile.config.twitchBotUserAccessToken) {
  logger.error('twitch bot user access token not provided');
  process.exit(11);
}

if (!confFile.config.twitchBotRefreshToken) {
  logger.error('twitch bot refresh token not provided');
  process.exit(12);
}

// ============================================================
// Twitch Helix API - App Access Token management & chat sender
// Required for Chat Bot Badge display
// ============================================================

let appAccessToken = null;
let tokenExpiresAt = 0;

async function getAppAccessToken() {
    const now = Date.now();

    // Reuse token if still valid (with 5 min buffer)
    if (appAccessToken && now < tokenExpiresAt - 300000) {
	return appAccessToken;
    }

    logger.info('Requesting new App Access Token...');

    const params = new URLSearchParams({
	client_id: confFile.config.twitchClientId,
	client_secret: confFile.config.twitchClientSecret,
	grant_type: 'client_credentials'
    });

    const res = await fetch('https://id.twitch.tv/oauth2/token', {
	method: 'POST',
	body: params
    });

    if (!res.ok) {
	const body = await res.text();
	logger.error('Failed to get App Access Token: ' + res.status + ' ' + body);
	throw new Error('App Access Token request failed');
    }

    const data = await res.json();
    appAccessToken = data.access_token;
    tokenExpiresAt = now + (data.expires_in * 1000);
    logger.info('App Access Token obtained, expires in ' + data.expires_in + 's');

    return appAccessToken;
}

async function helixSendMessage(message) {
    try {
	const token = await getAppAccessToken();

	const res = await fetch('https://api.twitch.tv/helix/chat/messages', {
	    method: 'POST',
	    headers: {
		'Authorization': 'Bearer ' + token,
		'Client-Id': confFile.config.twitchClientId,
		'Content-Type': 'application/json'
	    },
	    body: JSON.stringify({
		broadcaster_id: confFile.config.twitchBroadcasterId,
		sender_id: confFile.config.twitchBotUserId,
		message: message
	    })
	});

	if (!res.ok) {
	    const body = await res.text();
	    logger.error('Helix send message failed: ' + res.status + ' ' + body);

	    // Token may be invalid, reset it
	    if (res.status === 401) {
		appAccessToken = null;
		tokenExpiresAt = 0;
	    }
	    return { sent: false, messageId: null };
	}

	const data = await res.json();
	if (data.data && data.data[0] && data.data[0].is_sent) {
	    logger.debug('Helix message sent successfully, id: ' + data.data[0].message_id);
	    return { sent: true, messageId: data.data[0].message_id };
	} else {
	    logger.warn('Helix message may not have been sent: ' + JSON.stringify(data));
	    return { sent: false, messageId: null };
	}
    } catch (err) {
	logger.error('Helix send message error: ' + err.message);
	return { sent: false, messageId: null };
    }
}

// Wrapper: send chat message via Helix API (for bot badge)
// Falls back to tmi.js IRC if Helix fails
// Tracks message pair for auto-deletion
async function sendChatMessage(target, message, originalMsgId, originalUsername) {
    const result = await helixSendMessage(message);
    if (result.sent) {
	if (originalMsgId && result.messageId) {
	    messageMap.set(originalMsgId, {
		botMsgId: result.messageId,
		username: originalUsername || '',
		timestamp: Date.now()
	    });
	    logger.debug('Message mapping stored: ' + originalMsgId + ' -> ' + result.messageId);
	}
    } else {
	logger.warn('Helix API failed, falling back to IRC');
	client.say(target, message);
    }
}

// ============================================================
// Bot User Access Token management (for message deletion)
// Requires moderator:manage:chat_messages scope
// ============================================================

let botUserAccessToken = confFile.config.twitchBotUserAccessToken;
let botUserRefreshToken = confFile.config.twitchBotRefreshToken;
let botUserTokenExpiresAt = 0;
const TOKEN_FILE = './config/tokens.json';

function loadBotTokens() {
    try {
	if (fs.existsSync(TOKEN_FILE)) {
	    const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
	    botUserAccessToken = tokens.accessToken || botUserAccessToken;
	    botUserRefreshToken = tokens.refreshToken || botUserRefreshToken;
	    botUserTokenExpiresAt = tokens.expiresAt || 0;
	    logger.info('Bot tokens loaded from ' + TOKEN_FILE);
	}
    } catch (err) {
	logger.warn('Failed to load bot tokens from file: ' + err.message);
    }
}

function saveBotTokens() {
    try {
	fs.writeFileSync(TOKEN_FILE, JSON.stringify({
	    accessToken: botUserAccessToken,
	    refreshToken: botUserRefreshToken,
	    expiresAt: botUserTokenExpiresAt
	}, null, 2));
	logger.debug('Bot tokens saved to ' + TOKEN_FILE);
    } catch (err) {
	logger.error('Failed to save bot tokens: ' + err.message);
    }
}

async function refreshBotUserAccessToken() {
    logger.info('Refreshing Bot User Access Token...');

    const params = new URLSearchParams({
	client_id: confFile.config.twitchClientId,
	client_secret: confFile.config.twitchClientSecret,
	grant_type: 'refresh_token',
	refresh_token: botUserRefreshToken
    });

    const res = await fetch('https://id.twitch.tv/oauth2/token', {
	method: 'POST',
	body: params
    });

    if (!res.ok) {
	const body = await res.text();
	logger.error('Failed to refresh Bot User Access Token: ' + res.status + ' ' + body);
	throw new Error('Bot User Access Token refresh failed');
    }

    const data = await res.json();
    botUserAccessToken = data.access_token;
    botUserRefreshToken = data.refresh_token;
    botUserTokenExpiresAt = Date.now() + (data.expires_in * 1000);
    logger.info('Bot User Access Token refreshed, expires in ' + data.expires_in + 's');

    saveBotTokens();

    return botUserAccessToken;
}

async function getBotUserAccessToken() {
    const now = Date.now();

    // Known expiry and still valid
    if (botUserAccessToken && botUserTokenExpiresAt > 0 && now < botUserTokenExpiresAt - 300000) {
	return botUserAccessToken;
    }

    // First run — token from config, expiry unknown — use it as-is
    if (botUserAccessToken && botUserTokenExpiresAt === 0) {
	return botUserAccessToken;
    }

    // Expired — refresh
    return await refreshBotUserAccessToken();
}

loadBotTokens();

// ============================================================
// Message tracking for auto-deletion
// Maps original message ID -> { botMsgId, username, timestamp }
// ============================================================

const messageMap = new Map();
const MESSAGE_MAP_TTL = 6 * 60 * 60 * 1000; // 6 hours (Twitch API limit for deletion)

function cleanupMessageMap() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of messageMap) {
	if (now - value.timestamp > MESSAGE_MAP_TTL) {
	    messageMap.delete(key);
	    cleaned++;
	}
    }

    if (cleaned > 0) {
	logger.info('Message map cleanup: removed ' + cleaned + ' expired entries, ' + messageMap.size + ' remaining');
    }
}

// Cleanup every 30 minutes
setInterval(cleanupMessageMap, 30 * 60 * 1000);

// ============================================================
// Helix API - Delete chat message
// ============================================================

async function helixDeleteMessage(messageId) {
    try {
	let token = await getBotUserAccessToken();

	let res = await fetch(
	    'https://api.twitch.tv/helix/moderation/chat?broadcaster_id=' +
	    confFile.config.twitchBroadcasterId +
	    '&moderator_id=' + confFile.config.twitchBotUserId +
	    '&message_id=' + messageId,
	    {
		method: 'DELETE',
		headers: {
		    'Authorization': 'Bearer ' + token,
		    'Client-Id': confFile.config.twitchClientId
		}
	    }
	);

	// Token expired — refresh and retry once
	if (res.status === 401) {
	    logger.info('Bot User Access Token expired, refreshing...');
	    token = await refreshBotUserAccessToken();

	    res = await fetch(
		'https://api.twitch.tv/helix/moderation/chat?broadcaster_id=' +
		confFile.config.twitchBroadcasterId +
		'&moderator_id=' + confFile.config.twitchBotUserId +
		'&message_id=' + messageId,
		{
		    method: 'DELETE',
		    headers: {
			'Authorization': 'Bearer ' + token,
			'Client-Id': confFile.config.twitchClientId
		    }
		}
	    );
	}

	if (res.status === 204) {
	    logger.info('Successfully deleted bot message: ' + messageId);
	    return true;
	} else {
	    const body = await res.text();
	    logger.error('Failed to delete message ' + messageId + ': ' + res.status + ' ' + body);
	    return false;
	}
    } catch (err) {
	logger.error('helixDeleteMessage error: ' + err.message);
	return false;
    }
}

// ============================================================
// Event handlers for message deletion / timeout / ban
// ============================================================

function onMessageDeletedHandler(channel, username, deletedMessage, userstate) {
    const deletedMsgId = userstate['target-msg-id'];

    if (!deletedMsgId) { return; }

    const mapping = messageMap.get(deletedMsgId);

    if (mapping) {
	logger.info('Original message deleted [' + deletedMsgId + '], deleting translation [' + mapping.botMsgId + ']');
	helixDeleteMessage(mapping.botMsgId);
	messageMap.delete(deletedMsgId);
    }
}

function onTimeoutHandler(channel, username, reason, duration, userstate) {
    deleteAllTranslationsForUser(username, 'timeout (' + duration + 's)');
}

function onBanHandler(channel, username, reason, userstate) {
    deleteAllTranslationsForUser(username, 'ban');
}

function deleteAllTranslationsForUser(username, action) {
    let count = 0;

    for (const [originalMsgId, mapping] of messageMap) {
	if (mapping.username === username) {
	    logger.info('User ' + action + ' [' + username + '], deleting translation [' + mapping.botMsgId + ']');
	    helixDeleteMessage(mapping.botMsgId);
	    messageMap.delete(originalMsgId);
	    count++;
	}
    }

    if (count > 0) {
	logger.info('Deleted ' + count + ' translation(s) for user [' + username + '] due to ' + action);
    }
}

// ============================================================
// Main application
// ============================================================

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
client.on('messagedeleted', onMessageDeletedHandler);
client.on('timeout', onTimeoutHandler);
client.on('ban', onBanHandler);

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
		sendChatMessage(target, "ERROR: can't reload ignoring line list");
	    } else {
		logger.info("ignoring user list has been reloaded from " + ignoreLineFile);
		sendChatMessage(target, 'ignoring line list has been reloaded from json file');
	    }

	    break;

	case 1:
	    // ignoreusers
	    ignoreUsers = '';
	    ignoreUsers = JSON.parse(fs.readFileSync(iuJson, 'utf8')).ignoreusers;

	    if (!ignoreUsers) {
		logger.error("ERROR: can't reload " + iuJson);
		sendChatMessage(target, "ERROR: can't reload ignoring user list");
	    } else {
		logger.info("ignoring user list has been reloaded from " + iuJson);
		sendChatMessage(target, 'ignoring user list has been reloaded from json file');
	    }

	    break;

        case 2:
	    // emoticons
	    emotes = '';
	    emotes = JSON.parse(fs.readFileSync(emoticonJson, 'utf8')).emoticons;

	     if (!emotes) {
		logger.error("ERROR: can't reload " + emoticonJson);
		sendChatMessage(target, "ERROR: can't reload emoticons user list");
	    } else {
		logger.info("emoticons list has been reloaded from " + emoticonJson);
		sendChatMessage(target, 'emoticons list has been reloaded from json file');
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
	sendChatMessage(chatTarget, translation + ' (source lang: ' + fromLang + ')', context.id, context.username);
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
