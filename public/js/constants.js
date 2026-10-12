/**
 * Client-side mirror of server/constants.js
 *
 * Keep these in sync with the server manually.
 * These are the only strings ever used for socket events and game states
 * on the client — raw strings are never used anywhere else.
 */

const EVENTS = Object.freeze({
  // Client → Server
  C_ADMIN_AUTH:     'c:admin:auth',
  C_HOST_START:     'c:host:start',
  C_HOST_NEXT:      'c:host:next',
  C_HOST_END_ROUND: 'c:host:end:round',
  C_JOIN:           'c:join',
  C_REJOIN:         'c:rejoin',
  C_GUESS_SUBMIT:   'c:guess:submit',

  // Server → Client
  S_ADMIN_AUTH_OK:   's:admin:auth:ok',
  S_ADMIN_AUTH_FAIL: 's:admin:auth:fail',
  S_ROOM_JOINED:     's:room:joined',
  S_ROOM_PLAYERS:    's:room:players',
  S_GAME_COUNTDOWN:  's:game:countdown',
  S_ROUND_START:     's:round:start',
  S_ROUND_TICK:      's:round:tick',
  S_GUESS_ACK:       's:guess:ack',
  S_GUESS_COUNT:     's:guess:count',
  S_ROUND_REVEAL:    's:round:reveal',
  S_LEADERBOARD:     's:leaderboard',
  S_GAME_OVER:       's:game:over',
  S_GAME_STATE_SYNC: 's:game:state:sync',
  S_ERROR:           's:error',
});

const GAME_STATE = Object.freeze({
  LOBBY:           'LOBBY',
  ROUND_COUNTDOWN: 'ROUND_COUNTDOWN',
  ROUND_ACTIVE:    'ROUND_ACTIVE',
  ROUND_REVEAL:    'ROUND_REVEAL',
  LEADERBOARD:     'LEADERBOARD',
  GAME_OVER:       'GAME_OVER',
});

const ROUND_TYPE = Object.freeze({
  WORLD:  'world',
  CAMPUS: 'campus',
});

const ROLE = Object.freeze({
  HOST:   'host',
  PLAYER: 'player',
});

/**
 * sessionStorage keys used across playerApp and hostApp.
 * Centralised here so a key rename is one change not five.
 */
const SESSION_KEYS = Object.freeze({
  ROOM_CODE:    'gg_room',
  PLAYER_ID:    'gg_pid',
  NICKNAME:     'gg_nick',
  ADMIN_TOKEN:  'gg_admin_token',  // host only
  ROLE:         'gg_role',
});