#!/usr/local/bin/node

const reqp = require('request-promise-native')
const fs = require('fs')
const confFile = require('config')
const log4js = require('log4js')

log4js.configure({
  appenders: { system: { type: 'dateFile', filename: 'logs/emotelistupdate.log', pattern: "yyyyMMdd", compress: true } },
  categories: { default: { appenders: ['system'], level: 'debug' } }
})

const logger = log4js.getLogger('system')

const clientId = confFile.config.twitchClientId

if (!clientId) {
  logger.error('Twitch Client ID not provided')
  process.exit(1)
}

const twitchChannel = confFile.config.twitchChannel

if (!twitchChannel) {
  logger.error('Twitch Channel name not provided')
  process.exit(1)
}

const emoticonFile = './emoticons.json'

let result
var emoticons = [];

reqp({uri:'https://api.betterttv.net/2/emotes', json:true})
    .then((body)=>{
	let i = body.emotes.length;

	while (i--) {
	    emoticons.push(body.emotes[i].code);
	}

	logger.info('BTTV emoticons(global) list updated')
    })
    .then(()=>{
	reqp({uri:'https://api.frankerfacez.com/v1/room/' + twitchChannel, json:true})
	    .then((body)=>{
		let setid = body.room.set
		let i = body.sets[setid].emoticons.length

		while (i--) {
		    emoticons.push(body.sets[setid].emoticons[i].name)
		}

		logger.info('FFZ emoticons(userroom) list updated')
	    })
	    .catch((err)=>{
		logger.error(err);
	    });
    })
    .then(()=>{
	reqp({uri:'https://api.frankerfacez.com/v1/set/global', json:true})
	    .then((body)=>{
		let setid = body.default_sets
		let i = body.sets[setid].emoticons.length

		while (i--) {
		    emoticons.push(body.sets[setid].emoticons[i].name)
		}

		logger.info('FFZ emoticons(global) list updated')
	    })
	    .catch((err)=>{
		logger.error(err);
	    });
    })
    .then(()=>{
	let options = {
	    uri: 'https://api.twitch.tv/kraken/chat/emoticon_images',
	    method: 'GET',
	    timeout: 300,
	    headers: {
		'Client-ID': clientId,
		'Accept': 'application/vnd.twitchtv.v5+json',
	    },
	    json: true
	}

	reqp(options)
	    .then((body)=>{
		let i = body.emoticons.length

		while (i--) {
		    emoticons.push(body.emoticons[i].code)
		}

		logger.info('Twitch emoticons list updated')

		result = { "emoticons": emoticons }
		fs.writeFileSync(emoticonFile, JSON.stringify(result))

	    })
	    .catch((err)=>{
		logger.error(err);
	    });
    })
    .catch((err)=>{
	logger.error(err)
    })
