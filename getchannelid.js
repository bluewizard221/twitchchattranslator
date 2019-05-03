#!/usr/local/bin/node

const request = require('request')
const username = process.argv[2]
const confFile = require('config')

const twitchClientId = confFile.config.twitchClientId
const twitchChannel = confFile.config.twitchChannel
const oauthToken = confFile.config.oauthToken
const roomName = process.argv[3]

let queryURL = 'https://api.twitch.tv/helix/users?login=' + username

let headers = {
    'Client-ID': twitchClientId
}

let options = {
    url: queryURL,
    method: 'GET',
    headers: headers,
    json: true
}

request(options, function(error, response, body) {
    if (!error) {
	getChannelRoom(body.data[0].id)
	console.log('ID: ' + body.data[0].id)
    } else {
	console.log(error)
    }
})


function getChannelRoom(id) {
    let queryURL = 'https://api.twitch.tv/kraken/chat/' + id + '/rooms'

    let headers = {
	'Accept': 'application/vnd.twitchtv.v5+json',
	'Client-ID': twitchClientId,
	'Authorization': 'OAuth ' + oauthToken
    }

    let options = {
	url: queryURL,
	method: 'GET',
	headers: headers,
	json: true
    }

    request(options, function(error, response, body) {
	if (!error) {
	    let i = body.rooms.length
	    while (i--) {
		if (roomName === body.rooms[i].name) {
		    console.log('Room-ID: ' + body.rooms[i]._id)
		    break
		}
	    }
	} else {
	    console.log(error)
	}
    })
}
