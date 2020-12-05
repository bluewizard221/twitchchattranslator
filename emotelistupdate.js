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
  logger.error('Twitch Client ID is not provided')
  process.exit(1)
}

const twitchChannel = confFile.config.twitchChannel

if (!twitchChannel) {
  logger.error('Twitch Channel name is not provided')
  process.exit(2)
}

const twitchUserId = confFile.config.twitchUserId

if (!twitchUserId) {
  logger.error('Twitch User ID is not provided')
  process.exit(3)
}

const emoticonFile = './emoticons.json'

let result
var emoticons = [];

reqp({uri:'https://api.betterttv.net/3/cached/emotes/global', json:true})
    .then((body)=>{
	let i = body.length

	while (i--) {
	    emoticons.push(body[i].code)
	}

	logger.info('BTTV emoticons(global) list updated')
    })
    .then(()=>{
        reqp({uri:'https://api.betterttv.net/3/cached/users/twitch/' + twitchUserId, json:true})
            .then((body)=>{
                let i = body.channelEmotes.length;

                while (i--) {
                    emoticons.push(body.channelEmotes[i].code)
                }

                logger.info('BTTV emoticons(channel) list updated')

                i = body.sharedEmotes.length;

                while (i--) {
                    emoticons.push(body.sharedEmotes[i].code)
                }

                logger.info('BTTV emoticons(shared) list updated')
            })
            .catch((err)=>{
                logger.error(err)
            });
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
