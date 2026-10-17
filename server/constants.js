'use strict';

/** Maximum players allowed in a single room */
const MAX_PLAYERS = 150;

/** Length of the generated room join code */
const ROOM_CODE_LENGTH = 5;

// ─── Game State Machine ───────────────────────────────────────────────────────

/** @enum {string} */
const GAME_STATE = Object.freeze({
  LOBBY:            'LOBBY',
  ROUND_COUNTDOWN:  'ROUND_COUNTDOWN',
  ROUND_ACTIVE:     'ROUND_ACTIVE',
  ROUND_REVEAL:     'ROUND_REVEAL',
  LEADERBOARD:      'LEADERBOARD',
  GAME_OVER:        'GAME_OVER',
});

// ─── Timing (ms) ─────────────────────────────────────────────────────────────

const TIMING = Object.freeze({
  ROUND_COUNTDOWN_MS:          3_000,
  WORLD_ROUND_DURATION_MS:     60_000,
  CAMPUS_ROUND_DURATION_MS:    30_000,
  REVEAL_DURATION_MS:          12_000,
  LEADERBOARD_DURATION_MS:     8_000,
  FINAL_LEADERBOARD_DURATION_MS: 30_000,
});

// ─── Scoring ──────────────────────────────────────────────────────────────────

const SCORING = Object.freeze({
  MAX_POINTS_PER_ROUND: 1000,
  MIN_POINTS_PER_ROUND: 50,
  NO_GUESS_POINTS:      0,
});

// ─── Round Types ──────────────────────────────────────────────────────────────

/** @enum {string} */
const ROUND_TYPE = Object.freeze({
  WORLD:  'world',
  CAMPUS: 'campus',
});

// ─── Player Roles ─────────────────────────────────────────────────────────────

/** @enum {string} */
const ROLE = Object.freeze({
  HOST:   'host',
  PLAYER: 'player',
});

// ─── Socket Events ────────────────────────────────────────────────────────────

/**
 * All socket event names.
 * c_ = client → server
 * s_ = server → client
 */
const EVENTS = Object.freeze({
  // Client → Server
  C_ADMIN_AUTH:     'c:admin:auth',      // host submits password
  C_HOST_START:     'c:host:start',
  C_HOST_NEXT:      'c:host:next',       // advance reveal/leaderboard
  C_HOST_END_ROUND: 'c:host:end:round',  // force-end active round (NEW)
  C_JOIN:           'c:join',            // player joins with nickname
  C_REJOIN:         'c:rejoin',          // player rejoins by playerId (NEW)
  C_GUESS_SUBMIT:   'c:guess:submit',

  // Server → Client
  S_ADMIN_AUTH_OK:    's:admin:auth:ok',   // password accepted, room code returned
  S_ADMIN_AUTH_FAIL:  's:admin:auth:fail', // wrong password
  S_ROOM_JOINED:      's:room:joined',
  S_ROOM_PLAYERS:     's:room:players',
  S_GAME_COUNTDOWN:   's:game:countdown',
  S_ROUND_START:      's:round:start',
  S_ROUND_TICK:       's:round:tick',
  S_GUESS_ACK:        's:guess:ack',
  S_GUESS_COUNT:      's:guess:count',
  S_ROUND_REVEAL:     's:round:reveal',
  S_LEADERBOARD:      's:leaderboard',
  S_GAME_OVER:        's:game:over',
  S_GAME_STATE_SYNC:  's:game:state:sync', // full state sent on rejoin (NEW)
  S_ERROR:            's:error',
});

module.exports = {
  MAX_PLAYERS,
  ROOM_CODE_LENGTH,
  GAME_STATE,
  TIMING,
  SCORING,
  ROUND_TYPE,
  ROLE,
  EVENTS,
};