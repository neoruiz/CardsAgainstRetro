const path = require('path');
const express = require('express');
const app = express();
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const uuidv1 = require('uuid/v1');
const Moniker = require('moniker');
const names = Moniker.generator([Moniker.adjective, Moniker.noun, Moniker.verb]);
const Game = require('./game');

app.use(express.static('build'));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });


/* GOOGLE SPREADSHEET */

const fs = require('fs');
const readline = require('readline');
const {google} = require('googleapis');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = 'token.json';
let gCredentials;

// Load client secrets from a local file.
fs.readFile('credentials.json', (err, content) => {
  if (err) return console.log('Error loading client secret file:', err);
  // Authorize a client with credentials, then call the Google Sheets API.
  gCredentials = JSON.parse(content);
});

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
function authorize(credentials, callback) {
  const {client_secret, client_id, redirect_uris} = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
      client_id, client_secret, redirect_uris[0]);

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, (err, token) => {
    if (err) return getNewToken(oAuth2Client, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
function getNewToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error('Error while trying to retrieve access token', err);
      oAuth2Client.setCredentials(token);
      // Store the token to disk for later program executions
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) return console.error(err);
        console.log('Token stored to', TOKEN_PATH);
      });
      
      callback(oAuth2Client);
    });
  });
}
/* END OF SPREADSHEET */

app.get('/decks', cors(), (request, response) => {
  authorize(gCredentials, function(auth){
    const sheets = google.sheets({version: 'v4', auth});
    sheets.spreadsheets.get({
      spreadsheetId: '1I-VM0E-vMio1gxh9PTgrIggu_0l3H-Ui87GZ41yteoY'
    }, (err, res) => {
      if (err) return console.log('The API returned an error: ' + err);
      response.send(
        res.data.sheets
          .filter(sheet => sheet.properties.title != "White Cards")
          .map(sheet => sheet.properties.title)
      );
    });
  });
});


const rooms = new Map();
// keys are room ids
// values are objects with game instances

// Send to one connected client
wss.send = function send(socket, data) {
  if (socket.readyState === WebSocket.OPEN) {
    console.log('[SENT]', `[id: ${socket.id}]`, data);
    socket.send(data);
  }
};

// Send to all connected clients
wss.broadcast = function broadcast(data) {
  wss.clients.forEach(function each(client) {
    wss.send(client, data);
  });
};

// Handle disconnected clients
function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', function connection(ws) {
  if (ws.isAlive === false) {
    return ws.terminate();
  }
  ws.isAlive = true;
  ws.on('pong', heartbeat);
  ws.on('message', message => {
    try {
      console.log('[RECV]', `[id: ${ws.id}]`, message);
      const json = JSON.parse(message);
      const existingRoom = json.room && rooms.get(json.room); 
      if (json.type === 'join') {
        ws.name = String(json.name);
        if (existingRoom) {
          console.log('joining game room %s', json.room);
          // Join an existing room
          existingRoom.join(ws);
        }
        else {
          // Create a new game room and join it
          let gameId;
          while (!gameId || rooms.get(gameId)) {
            gameId = json.room || names.choose();
          }
          console.log('creating new game room %s', gameId);

          /* Create new room with the selected Deck */
          authorize(gCredentials, function(auth){
            const sheets = google.sheets({version: 'v4', auth});
            let Deck = {
              "blackCards": [],
              "whiteCards": [],
              "Base": {
                "name": "Base Set",
                "black": [],
                "white": []
              }
            };

            sheets.spreadsheets.values.get({
              spreadsheetId: '1I-VM0E-vMio1gxh9PTgrIggu_0l3H-Ui87GZ41yteoY',
              range: json.deck + '!A1:B',
            }, (err, res) => {
              if (err) return console.log('The API returned an error: ' + err);
              const rows = res.data.values;
              if (rows.length) {
                rows.map((row, index) => {
                  Deck.blackCards.push({
                    "text": row[0],
                    "pick": 1 
                  })
                  Deck.Base.black.push(index);
                });
              } else {
                console.log('No data found.');
              }

              sheets.spreadsheets.values.get({
                spreadsheetId: '1I-VM0E-vMio1gxh9PTgrIggu_0l3H-Ui87GZ41yteoY',
                range: 'White Cards!A1:B',
              }, (err, res) => {
                if (err) return console.log('The API returned an error: ' + err);
                const rows = res.data.values;
                if (rows.length) {
                  rows.map((row, index) => {
                    Deck.whiteCards.push("<img src='" + row[0] + "' />");
                    Deck.Base.white.push(index);
                  });
  
                  rooms.set(gameId, new Game(wss, gameId, json.gameType, Deck));
                  rooms.get(gameId).join(ws);
                  // Clean up this room after 6 hours
                  setTimeout(() => rooms.delete(gameId), 1000 * 60 * 60 * 6);
                } else {
                  console.log('No data found.');
                }
              });
            });

          });
          /* End of Create new room with the selected Deck */

        }
      } else if (existingRoom && json.type === 'play') {
        existingRoom.handlePlay(ws, json);
      } else if (existingRoom && json.type === 'advance') {
        existingRoom.handleAdvance(ws, json);
      } else if (existingRoom && json.type === 'select') {
        existingRoom.handleSelect(ws, json);
      }
    }
    catch (e) {
      console.error(e);
    }
  });
});

setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    ws.isAlive = false;
    ws.ping('', false, true);
  });
}, 10000);

server.listen(process.env.PORT || 3002, function() {
  var host = server.address().address;
  var port = server.address().port;
  console.log('[WEB] listening at http://%s:%s', host, port);
});
