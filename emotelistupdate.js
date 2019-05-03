#!/usr/local/bin/node

const fs = require('fs')
const request = require('sync-request')
const confFile = require('config')
const log4js = require('log4js')

log4js.configure({
  appenders: { system: { type: 'dateFile', filename: 'logs/jsonupdate.log', pattern: "-yyyyMMdd", compress: true } },
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

let result = {
    "emoticons": []
}

let queryURL = 'https://api.betterttv.net/2/emotes'

let res = request('GET', queryURL)
let body = JSON.parse(res.getBody())

let i = body.emotes.length

while (i--) {
    result.emoticons.push(body.emotes[i].code)
}

logger.info('BTTV emoticons(global) list updated')


queryURL = 'https://api.frankerfacez.com/v1/room/' + twitchChannel

options = {
    url: queryURL,
    method: 'GET',
    json: true
}

res = request('GET', queryURL)
body = JSON.parse(res.getBody())

setid = body.room.set
i = body.sets[setid].emoticons.length

while (i--) {
    result.emoticons.push(body.sets[setid].emoticons[i].name)
}

logger.info('FFZ emoticons(userroom) list updated')


queryURL = 'https://api.frankerfacez.com/v1/set/global'

res = request('GET', queryURL)
body = JSON.parse(res.getBody())

setid = body.default_sets
i = body.sets[setid].emoticons.length

while (i--) {
    result.emoticons.push(body.sets[setid].emoticons[i].name)
}

logger.info('FFZ emoticons(global) list updated')


queryURL = 'https://api.twitch.tv/kraken/chat/emoticon_images'

res = request('GET', queryURL, {
    headers: {
	'Client-ID': clientId,
	'Accept': 'application/vnd.twitchtv.v5+json',
    },
});

body = JSON.parse(res.getBody())
i = body.emoticons.length

while (i--) {
    result.emoticons.push(body.emoticons[i].code)
}

logger.info('Twitch emoticons list updated')


fs.writeFileSync(emoticonFile, JSON.stringify(result))
