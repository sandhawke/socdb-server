#!/usr/bin/env node   
'use strict'  //  -*-mode: javascript -*- 

// BUG -- server-secrets lasts a while, recognizing clients, while the
// db which hands out ids does NOT.

// maybe command line for file to use, for saving

// maybe command line for one app

// maybe command line for port

const express = require('express')
const datapages = require('datapages')
const browserify = require('browserify')
const launcher = require('james-browser-launcher')
const path = require('path')
const glob = require('glob')
const LoginWithTwitter = require('login-with-twitter')
const minimist = require('minimist')
const config = require('./.secret')  // or use env?
const crypto = require('crypto')
const argv = minimist(process.argv.slice(2), {
  alias: {
    'ff': 'firefox'
  }
})

async function start () {
  const dps = new datapages.Server({db: new datapages.FlatFile('data.csv'),
    port: process.env.PORT || 1978,
    doOwners: true
  })

  dps.db.on('change', (page, delta) => {
    console.log('page changed %o', delta)
  })

  const server = dps.transport
  // implied by webgram
  // server.app.use(express.static('./static'))
  // {extensions: ['html', 'css']}))

  server.answer.claimTwitter = claim
  
  server.app.get('/bundle.js', js)
  server.app.get('/twitter/authorize', twAuth)
  server.app.get('/twitter/callback', twCallback)

  // making /* is a little risky: if style.css is missing or something,
  // we'll get a syntax error, because we'll serve app's html.  I guess
  // we could check the Accept header..
  server.app.get('/*', app)
  // server.app.get('/*/*', app)
  // server.app.get('/*/*/*', app)

  await server.start()

  launcher((err, launch) => {
    // console.log(launch.browsers)
    if (err) throw err
    if (argv.firefox || argv.launch) {
      launch(server.siteURL, 'firefox', (err, instance) => {
        // IGNORE: if (err) throw err
      })
    }
    if (argv.chrome || argv.launch) {
      launch(server.siteURL, 'chrome', (err, instance) => {
        // IGNORE: if (err) throw err
      })
    }
  })

  config.callbackUrl = server.siteURL + '/twitter/callback'
  console.log('twitter callback to', config.callbackUrl)

  const claimable = {}
  const tw = new LoginWithTwitter(config)
  function twAuth (req, res) {
    tw.authorize((err, url) => {
      if (err) throw Error(err)
      res.redirect(url)
    })
  }
  function twCallback (req, res) {
    tw.callback(req.query, (err, auth) => {
      if (err) throw Error(err)
      // this is kind of weird, as a way for client JS to connect
      // itself to this Twitter identity, but it seems okay, I guess.
      // We make up some random bytes, the 'rcpt', and give them to
      // the client to use in claiming this identity, later, via a
      // datapages operation.
      crypto.randomBytes(16, (err, bytes) => {
        if (err) throw err
        const rcpt = bytes.toString('hex')
        claimable[rcpt] = auth
        console.log('auth info', auth)
        const info = { rcpt, userName: auth.userName, userId: auth.userId }
        req.extraJS = `\nwindow.twitterInfo=${JSON.stringify(info)}`
        // the local JS should look for this, use it to claim the identity,
        // then probably redirect back to the root URL, or somewhere else it
        // stashed.
        return app(req, res)
      })
    })
  }
  async function claim (conn, info) {
    console.log('%o claiming %o', conn.sessionData, info)
    if (info === 'logout') {
      conn.sessionData.twitterUserName = undefined
      conn.sessionData.twitterUserId = undefined
      conn.sessionData.twitterUserToken = undefined
      conn.sessionData.twitterUserTokenSecret = undefined
      const page = conn.sessionData.twitterAuthPage
      if (page) {
        conn.sessionData.twitterAuthPage = undefined
        dps.db.delete(page)
      }
      conn.save()
      return server.siteURL
    }
    const auth = claimable[info.rcpt]
    if (auth) {
      // this stuff is persistent on the server, NOT sent to client
      conn.sessionData.twitterUserName = auth.userName
      conn.sessionData.twitterUserId = auth.userId
      conn.sessionData.twitterUserToken = auth.userToken
      conn.sessionData.twitterUserTokenSecret = auth.userTokenSecret
      // now tell the client, and everyone else (!!!) this session is
      // this twitter user
      const id = dps.db.create({isTwitterAuth: true,
                 sessionID: conn.sessionData._sessionID,
                                twitterUserName: auth.userName})
      conn.sessionData.twitterAuthPage = id
      conn.save()
      console.log('saved!')
    } else {
      console.log('bad claimTwitter')
    }
    return server.siteURL
  }

  function app (req, res) {
    const script = '<script type="text/javascript" src="' + server.siteURL + '/bundle.js"></script>'
    const msg = '' // 'loading'
    let addr = server.address
    // WORKAROUND
    // const addr = 'wss://evi.center/'
    // WORKAROUND
    if (process.env.WSS) {
      addr = process.env.WSS
    }
    res.send(
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title></title>
<link rel="stylesheet" type="text/css" href="/style.css" />
<script type="text/javascript">
window.serverAddress='${addr}'${req.extraJS || ''}
console.log('# running datapages demo, server=', window.serverAddress
)
</script>
</head>
<body>
<div id="app">
<p>${msg}</p>
</div>
${script}
</body>`)
  }

  function js (req, res) {
    // debug makes bundle much larger, but has source map
    // const appjs = browserify(path.join(__dirname, 'app'), {debug: true})
    const appjs = browserify('app', {debug: true})
    appjs.bundle().on('error', function (err) {
      console.error('CAUGHT ERROR', err)
      res.set('Content-Type', 'application/javascript')
      res.send('alert("error packaging app")')
      this.emit('end')
    }).pipe(res)
  }
}

start()
