'use strict';

/**
 * All game constants in one place.
 * Never use magic numbers or strings anywhere else in the codebase.
 */

// ─── Room / Game ────────────────────────────────────────────────────────────

/** Maximum players allowed in a single room */
const MAX_PLAYERS = 150;

/** Length of the generated room join code */
const ROOM_CODE_LENGTH = 5;

// ─── Game State Machine ──────────────────────────────────────────────────────

/** @enum {string} All possible states a room can be in */
const GAME_STATE = Object.freeze({
  LOBBY: 'LOBBY',               // Waiting for host to start
  ROUND_COUNTDOWN: 'ROUND_COUNTDOWN', // 3-2-1 before each round
  ROUND_ACTIVE: 'ROUND_ACTIVE', // Players are guessing
  ROUND_REVEAL: 'ROUND_REVEAL', // Correct pin + all guesses revealed
  LEADERBOARD: 'LEADERBOARD',   // Mid-game or end leaderboard screen
  GAME_OVER: 'GAME_OVER',       // Final state, game has ended
});

// ─── Timing (all in milliseconds) ────────────────────────────────────────────

const TIMING = Object.freeze({
  /** Countdown before a round starts */
  ROUND_COUNTDOWN_MS: 3_000,

  /** Default guess window for world rounds */
  WORLD_ROUND_DURATION_MS: 45_000,

  /** Guess window for campus rounds (shorter — local knowledge) */
  CAMPUS_ROUND_DURATION_MS: 30_000,

  /** Time to show pin reveal animation */
  REVEAL_DURATION_MS: 12_000,

  /** Time to show leaderboard between rounds */
  LEADERBOARD_DURATION_MS: 8_000,

  /** Extra time at end for final leaderboard */
  FINAL_LEADERBOARD_DURATION_MS: 30_000,
});

// ─── Scoring ─────────────────────────────────────────────────────────────────

const SCORING = Object.freeze({
  /** Points awarded to the 1st place guesser each round */
  MAX_POINTS_PER_ROUND: 1000,

  /** Minimum points awarded to any player who submitted a guess */
  MIN_POINTS_PER_ROUND: 50,

  /**
   * Players who do not submit a guess get zero points for that round.
   * This is distinct from MIN_POINTS (which applies to any submitted guess).
   */
  NO_GUESS_POINTS: 0,
});

// ─── Round Types ──────────────────────────────────────────────────────────────

/** @enum {string} */
const ROUND_TYPE = Object.freeze({
  WORLD: 'world',
  CAMPUS: 'campus',
});

// ─── Socket Events ────────────────────────────────────────────────────────────

/**
 * All Socket.io event names in one place.
 * Client and server must always use these constants (never raw strings).
 * Prefix c_ = emitted by client, s_ = emitted by server.
 */
const EVENTS = Object.freeze({
  // Client → Server
  C_JOIN: 'c:join',
  C_HOST_CREATE: 'c:host:create',
  C_HOST_START: 'c:host:start',
  C_HOST_NEXT: 'c:host:next',         // Advance to next round (host only)
  C_GUESS_SUBMIT: 'c:guess:submit',

  // Server → Client (room-wide broadcasts)
  S_ROOM_JOINED: 's:room:joined',
  S_ROOM_PLAYERS: 's:room:players',   // Updated player list
  S_GAME_COUNTDOWN: 's:game:countdown',
  S_ROUND_START: 's:round:start',
  S_ROUND_TICK: 's:round:tick',       // Timer tick every second
  S_GUESS_ACK: 's:guess:ack',         // Ack to the individual guesser
  S_GUESS_COUNT: 's:guess:count',     // Live "X/100 guessed" for host display
  S_ROUND_REVEAL: 's:round:reveal',   // Correct answer + all guesses + scores
  S_LEADERBOARD: 's:leaderboard',     // Full leaderboard snapshot
  S_GAME_OVER: 's:game:over',         // Final scores

  // Server → Client (individual errors)
  S_ERROR: 's:error',
});

// ─── Player Roles ─────────────────────────────────────────────────────────────

/** @enum {string} */
const ROLE = Object.freeze({
  HOST: 'host',
  PLAYER: 'player',
});

module.exports = {
  MAX_PLAYERS,
  ROOM_CODE_LENGTH,
  GAME_STATE,
  TIMING,
  SCORING,
  ROUND_TYPE,
  EVENTS,
  ROLE,
};