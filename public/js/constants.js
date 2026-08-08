/**
 * Client-side mirror of server/constants.js
 * Keep these in sync with the server. These are the only strings
 * the client ever uses for socket events and game states — never raw strings.
 */

const EVENTS = Object.freeze({
  C_JOIN:         'c:join',
  C_HOST_CREATE:  'c:host:create',
  C_HOST_START:   'c:host:start',
  C_HOST_NEXT:    'c:host:next',
  C_GUESS_SUBMIT: 'c:guess:submit',

  S_ROOM_JOINED:    's:room:joined',
  S_ROOM_PLAYERS:   's:room:players',
  S_GAME_COUNTDOWN: 's:game:countdown',
  S_ROUND_START:    's:round:start',
  S_ROUND_TICK:     's:round:tick',
  S_GUESS_ACK:      's:guess:ack',
  S_GUESS_COUNT:    's:guess:count',
  S_ROUND_REVEAL:   's:round:reveal',
  S_LEADERBOARD:    's:leaderboard',
  S_GAME_OVER:      's:game:over',
  S_ERROR:          's:error',
});

const GAME_STATE = Object.freeze({
  LOBBY:            'LOBBY',
  ROUND_COUNTDOWN:  'ROUND_COUNTDOWN',
  ROUND_ACTIVE:     'ROUND_ACTIVE',
  ROUND_REVEAL:     'ROUND_REVEAL',
  LEADERBOARD:      'LEADERBOARD',
  GAME_OVER:        'GAME_OVER',
});

const ROUND_TYPE = Object.freeze({
  WORLD:  'world',
  CAMPUS: 'campus',
});