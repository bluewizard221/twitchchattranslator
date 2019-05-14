#!/usr/local/bin/node

const tmi = require('tmi.js')
const request = require('request')
const fs = require('fs')
const confFile = require('config')
const log4js = require('log4js')

log4js.configure({
  appenders: { system: { type: 'dateFile', filename: 'logs/twitchchattranslator.log', pattern: "-yyyyMMdd", compress: true } },
  categories: { default: { appenders: ['system'], level: 'debug' } }
})

const logger = log4js.getLogger('system')

// loading config from configfile
const pidFile = confFile.config.pidFile

if (!pidFile) {
  logger.error('Pidfile is not provided')
  process.exit(1)
}

const googleApiKey = confFile.config.googleApiKey

if (!googleApiKey) {
  logger.error('googleApiKey is not provided')
  process.exit(1)
}

const twitchUserName = confFile.config.twitchUserName

if (!twitchUserName) {
  logger.error('twitch user_name not provided')
  process.exit(3)
}

const twitchOauth = confFile.config.twitchOauth

if (!twitchOauth) {
  logger.error('twitch oauth token not provided')
  process.exit(4)
}

const twitchChannel = confFile.config.twitchChannel

if (!twitchChannel) {
  logger.error('twitch channel URL not provided')
  process.exit(5)
}

const twitchChannelId = confFile.config.twitchChannelId

if (!twitchChannelId) {
  logger.error('twitch channel ID not provided')
  process.exit(5)
}

const coolDownCount = confFile.config.coolDownCount

if (!coolDownCount) {
  logger.error('max count for cool down timer not provided')
  process.exit(5)
}

// setting up channel room and chat target
const twitchRoomId = confFile.config.twitchRoomId
const targetisOtherRoom = confFile.config.targetisOtherRoom
let chatTarget = ''
let connectChannel = []

if (targetisOtherRoom && twitchRoomId) {
    chatTarget = '#chatrooms:' + twitchChannelId + ':' + twitchRoomId
    connectChannel.push(twitchChannel)
    connectChannel.push('chatrooms:' + twitchChannelId + ':' + twitchRoomId)
} else {
    chatTarget = '#' + twitchChannel
    connectChannel.push(twitchChannel)
}

// setting up ignore users list
const iuJson = './ignoreusers.json'
let ignoreUsers = JSON.parse(fs.readFileSync(iuJson, 'utf8')).ignoreusers

if (!ignoreUsers) {
  logger.error('Ignore users list not provided')
  process.exit(7)
}

// setting up emoticons list
const emoticonJson = './emoticons.json'
let emotes = JSON.parse(fs.readFileSync(emoticonJson, 'utf8')).emoticons

if (!emotes) {
  logger.error('Emoticons list not provided')
  process.exit(8)
}

// setting up ignore line list
const ignoreLineFile = './ignoreline.json'
let ignoreLine = JSON.parse(fs.readFileSync(ignoreLineFile, 'utf8')).ignorelines

if (!ignoreLine) {
  logger.error('Ignore Line not provided')
  process.exit(9)
}

// setting up Google Cloud Translation API
const googleTranslate = require('google-translate')(googleApiKey)

// JSON for cool down timer
let coolDown = {}

fs.writeFile(pidFile, process.pid, (err) => {
  if (err) {
    logger.error(err)
  }
})

// setting up tmi.js
const ops = {
    identity: {
	username: twitchUserName,
	password: twitchOauth
    },
    channels: connectChannel
}

const client = new tmi.client(ops)

client.on('message', onMessageHandler)
client.on('connected', onConnectedHandler)

client.connect()

function onMessageHandler(target, context, msg, self) {
    if (self) { return } // Ignore messages from bot

    //Remove whitespace from chat
    let line = msg.trim()

    if (isIgnoreLine(line)) { return }

    //Command check
    if (line === '!refreshignoreuser') {
	refreshIgnoreUser(target, context)
	return
    } else if (line === '!refreshignoreline') {
	refreshIgnoreLine(target, context)
	return
    } else if (line === '!refreshemoticons') {
	refreshEmoticonsList(target, context)
	return
    } else if (line.match(/^\!switchtarget/)) {
	switchTarget(target, context, line)
	return
    } else if (line.match(/^\!/)) {
	return
    }

    if (isIgnoreUser(context)) { return } // Ignore listed user(like bot)

    if (isSpammingUser(target, context)) { return }

    line = removeEmoticons(line)

    if (line === '') { return }

    translateMessage(chatTarget, context, line)
}

function isSpammingUser(target, context) {
    let username = context.username
    let now = Date.now()

    if (context.mod === true || context.username == twitchChannel) {
	logger.info("user [" + context.username + "] is kinda modelator. I skip spamcheck..")
	return 0
    }

    if (coolDown[username]) {
	if (coolDown[username].count >= coolDownCount) {
	    logger.info("user [" + context.username + "] exceeded cool down threshold value")
	    return 1
	}

	if ((now - coolDown[username].latest) <= 60000) {
	    coolDown[username].count++
	} else {
	    coolDown[username].count = 1
	    coolDown[username].latest = now
	}
    } else {
	coolDown[username] = {}
	coolDown[username].count = 1
	coolDown[username].latest = now
    }

    return 0
}

function isIgnoreLine(line) {
    let match = 0
    let i = 0

    for (i = 0; i < ignoreLine.length; i++) {
	let regex = new RegExp(ignoreLine[i])

	if (line.match(regex)) {
	    logger.info("line matched ignore rule. line [" + line + "], rule [" + regex + "]")
	    match = 1
	    break
	}
    }

    return match
}

function switchTarget(target, context, line) {
    if (context.mod === false && context.username !== twitchChannel) { return }

    if (targetisOtherRoom === 0 || twitchRoomId == '') {
	client.say(target, "/me you don't set any other room for me, so I don't do re-joining any other channel")
	return
    }

    if (line.match(/^!switchtarget room$/)) {
	chatTarget = '#chatrooms:' + twitchChannelId + ':' + twitchRoomId

	logger.info("target switched: [" + twitchRoomId + "]")
	client.say(target, "/me OK, I will put any translated messages on other channel what you specified")
    } else if (line.match(/^!switchtarget main$/)) {
	chatTarget = '#' + twitchChannel

	logger.info("target switched: [" + twitchChannel + "]")
	client.say(target, "OK, I will put any translated messages on main chat room")
    } else {
	logger.info("wrong command: [" + line + "]")
	client.say(target, "/me Usage: !switchtarget (room|main)")
    }

    return
}

function refreshIgnoreUser(target, context) {
    if (context.mod === false && context.username !== twitchChannel) { return }

    ignoreUsers = ''
    ignoreUsers = JSON.parse(fs.readFileSync(iuJson, 'utf8')).ignoreusers

    if (!ignoreUsers) {
	logger.error("ERROR: can't reload " + iuJson)
	client.say(target, "/me ERROR: can't reload ignoring user list")
    } else {
	logger.info("ignoring user list has been reloaded from " + iuJson)
	client.say(target, '/me ignoring user list has been reloaded from json file')
    }

    return
}

function refreshIgnoreLine(target, context) {
    if (context.mod === false && context.username !== twitchChannel) { return }

    ignoreLine = ''
    ignoreLine = JSON.parse(fs.readFileSync(ignoreLineFile, 'utf8')).ignorelines

    if (!ignoreLine) {
	logger.error("ERROR: can't reload " + ignoreLineFile)
	client.say(target, "/me ERROR: can't reload ignoring line list")
    } else {
	logger.info("ignoring user list has been reloaded from " + ignoreLineFile)
	client.say(target, '/me ignoring line list has been reloaded from json file')
    }

    return
}

function refreshEmoticonsList(target, context) {
    if (context.mod === false && context.username !== twitchChannel) { return }

    emotes = ''
    emotes = JSON.parse(fs.readFileSync(emoticonJson, 'utf8')).emoticons

    if (!emotes) {
	logger.error("ERROR: can't reload " + emoticonJson)
	client.say(target, "/me ERROR: can't reload emoticons user list")
    } else {
	logger.info("emoticons list has been reloaded from " + emoticonJson)
	client.say(target, '/me emoticons list has been reloaded from json file')
    }

    return
}

function isIgnoreUser(context) {
    if (ignoreUsers.indexOf(context.username) !== -1) {
	return 1
    } else {
	return 0
    }
}

function removeEmoticons(line) {
    let search = line.split(' ')
    let i = emotes.length

   while (i--) {
	let index = search.indexOf(emotes[i])

	while (index !== -1) {
//	    logger.info('DEBUG: hits [' + emotes[i] + ']')
	    search.splice(index, 1)
	    index = search.indexOf(emotes[i])
	}
    }

    return search.join(' ')
}

function translateMessage(target, context, line) {
    let toLang = 'ja'

    if (line.match(/[\u30a0-\u30ff\u3040-\u309f\u3005-\u3006\u30e0-\u9fcf]/)) {
	toLang = 'en'
    } else {
	toLang = 'ja'
    }

//    logger.info('DEBUG: line [' + line + ']')

    googleTranslate.translate(line, toLang, function(err, translation) {
	if (err) {
	    logger.info(err)
	} else {
	    client.say(target, '/me ' + translation.translatedText + ' ([' + translation.detectedSourceLanguage + '] => [' + toLang + '])')
	}
    })
}

function onConnectedHandler(addr, port) {
    logger.info('Connected to twitch chat channel [' + addr + ':' + port + ']')
}

process.on('SIGINT', () => {
    logger.info('SIGINT caught. shutting down...')

    process.exit(0)
})

process.on('SIGHUP', () => {
    logger.info('SIGHUP caught. refreshing database...')

    ignoreUsers = ''
    ignoreUsers = JSON.parse(fs.readFileSync(iuJson, 'utf8')).ignoreusers

    if (!ignoreUsers) {
	logger.error("ERROR: can't reload " + iuJson)
	client.say('#' + twitchChannel, "/me ERROR: can't reload ignoring user list")
    } else {
	logger.info("ignoring user list has been reloaded from " + iuJson)
	client.say('#' + twitchChannel, '/me ignoring user list has been reloaded from json file')
    }


    ignoreLine = ''
    ignoreLine = JSON.parse(fs.readFileSync(ignoreLineFile, 'utf8')).ignorelines

    if (!ignoreLine) {
	logger.error("ERROR: can't reload " + ignoreLineFile)
	client.say('#' + twitchChannel, "/me ERROR: can't reload ignoring line list")
    } else {
	logger.info("ignoring user list has been reloaded from " + ignoreLineFile)
	client.say('#' + twitchChannel, '/me ignoring line list has been reloaded from json file')
    }

    emotes = ''
    emotes = JSON.parse(fs.readFileSync(emoticonJson, 'utf8')).emoticons

    if (!emotes) {
	logger.error("ERROR: can't reload " + emoticonJson)
	client.say('#' + twitchChannel, "/me ERROR: can't reload emoticons user list")
    } else {
	logger.info("emoticons list has been reloaded from " + emoticonJson)
	client.say('#' + twitchChannel, '/me emoticons list has been reloaded from json file')
    }
})
