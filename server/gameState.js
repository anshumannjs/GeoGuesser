'use strict';

const logger   = require('./logger');
const { GAME_STATE, TIMING, EVENTS, ROUND_TYPE, ROLE } = require('./constants');
const { GameError, ERROR_CODE }  = require('./errors');
const { loadRounds, buildRoundSequence, getRound, getRoundDuration, sanitiseRoundForClient } = require('./rounds');
const { scoreRound, buildLeaderboard, buildRevealPayload } = require('./scoring');
const rooms = require('./rooms');

// ─── Module-level round data (loaded once at startup) ─────────────────────────

let _worldRounds  = null;
let _campusRounds = null;

/**
 * Load round data from disk.
 * Must be called once before any room can start a game.
 */
function initialise() {
  const { worldRounds, campusRounds } = loadRounds();
  _worldRounds  = worldRounds;
  _campusRounds = campusRounds;
  logger.info(
    { worldRounds: worldRounds.length, campusRounds: campusRounds.length },
    'GameState initialised'
  );
}

// ─── Per-room volatile state ──────────────────────────────────────────────────

/**
 * Stores runtime game state that is not part of the Room object itself.
 * Key: roomCode
 * Value: GameSession
 *
 * @type {Map<string, GameSession>}
 */
const sessions = new Map();

/**
 * @typedef {Object} GameSession
 * @property {string}    roomCode
 * @property {Round[]}   sequence        Ordered round array for this game
 * @property {number}    currentIndex    0-based index into sequence (-1 = not started)
 * @property {Map<string, RawGuess>} guesses  playerId → guess for current round
 * @property {NodeJS.Timeout|null}  roundTimer
 * @property {NodeJS.Timeout|null}  tickTimer
 * @property {number|null}          roundEndsAt  Unix ms timestamp when round timer expires
 */

/**
 * @typedef {Object} RawGuess
 * @property {string} playerId
 * @property {Object} coord
 * @property {number} submittedAt
 */

// ─── Session Helpers ──────────────────────────────────────────────────────────

/**
 * Get an existing session or throw.
 *
 * @param {string} roomCode
 * @returns {GameSession}
 */
function _getSession(roomCode) {
  const session = sessions.get(roomCode);
  if (!session) {
    throw new GameError(
      `No active game session for room "${roomCode}"`,
      ERROR_CODE.INVALID_STATE_TRANSITION
    );
  }
  return session;
}

/**
 * Create a fresh session for a room.
 *
 * @param {string} roomCode
 * @returns {GameSession}
 */
function _createSession(roomCode) {
  const sequence = buildRoundSequence(_worldRounds, _campusRounds, {
    maxWorldRounds:  6,
    maxCampusRounds: 4,
    shuffleCampus:   true,
    shuffleWorld:    false,
  });

  /** @type {GameSession} */
  const session = {
    roomCode,
    sequence,
    currentIndex:  -1,
    guesses:       new Map(),
    roundTimer:    null,
    tickTimer:     null,
    roundEndsAt:   null,
  };

  sessions.set(roomCode, session);
  return session;
}

/**
 * Clear all active timers for a session.
 *
 * @param {GameSession} session
 */
function _clearTimers(session) {
  if (session.roundTimer) {
    clearTimeout(session.roundTimer);
    session.roundTimer = null;
  }
  if (session.tickTimer) {
    clearInterval(session.tickTimer);
    session.tickTimer = null;
  }
  session.roundEndsAt = null;
}

/**
 * Fully tear down a session (called when game ends or room is destroyed).
 *
 * @param {string} roomCode
 */
function destroySession(roomCode) {
  const session = sessions.get(roomCode);
  if (!session) return;
  _clearTimers(session);
  sessions.delete(roomCode);
  logger.info({ roomCode }, 'Game session destroyed');
}

// ─── State Guards ─────────────────────────────────────────────────────────────

/**
 * Assert that a room is currently in one of the expected states.
 * Throws GameError if not.
 *
 * @param {import('./rooms').Room} room
 * @param {...string}              expectedStates
 */
function _assertState(room, ...expectedStates) {
  if (!expectedStates.includes(room.state)) {
    throw new GameError(
      `Invalid state transition: room is in "${room.state}" ` +
      `but expected one of [${expectedStates.join(', ')}]`,
      ERROR_CODE.INVALID_STATE_TRANSITION
    );
  }
}

// ─── Game Lifecycle ───────────────────────────────────────────────────────────

/**
 * Start a game for a room.
 * Transitions: LOBBY → ROUND_COUNTDOWN → ROUND_ACTIVE
 *
 * @param {string}             roomCode
 * @param {SocketIO.Namespace} io        Socket.io server (for broadcasting)
 */
function startGame(roomCode, io) {
  if (!_worldRounds) {
    throw new GameError('GameState not initialised — call initialise() first', ERROR_CODE.INTERNAL);
  }

  const room = rooms.getRoom(roomCode);
  _assertState(room, GAME_STATE.LOBBY);

  const playerCount = [...room.players.values()].filter(
    (p) => p.role === ROLE.PLAYER
  ).length;

  if (playerCount < 1) {
    throw new GameError(
      'Cannot start a game with no players',
      ERROR_CODE.NOT_ENOUGH_PLAYERS
    );
  }

  const session = _createSession(roomCode);
  room.state    = GAME_STATE.ROUND_COUNTDOWN;

  logger.info(
    { roomCode, totalRounds: session.sequence.length, playerCount },
    'Game starting'
  );

  // Brief countdown before first round
  io.to(roomCode).emit(EVENTS.S_GAME_COUNTDOWN, {
    countdownMs: TIMING.ROUND_COUNTDOWN_MS,
    totalRounds: session.sequence.length,
  });

  setTimeout(() => _startRound(roomCode, io), TIMING.ROUND_COUNTDOWN_MS);
}

// ─── Round Lifecycle ──────────────────────────────────────────────────────────

/**
 * Begin the next round.
 * Transitions: ROUND_COUNTDOWN | LEADERBOARD → ROUND_ACTIVE
 *
 * @param {string}             roomCode
 * @param {SocketIO.Namespace} io
 */
function _startRound(roomCode, io) {
  const room    = rooms.getRoom(roomCode);
  const session = _getSession(roomCode);

  session.currentIndex += 1;

  const round = getRound(session.sequence, session.currentIndex);

  if (!round) {
    // No more rounds — end the game
    _endGame(roomCode, io);
    return;
  }

  // Reset per-round guess map
  session.guesses = new Map();

  // Transition state
  room.state = GAME_STATE.ROUND_ACTIVE;

  const durationMs    = getRoundDuration(round, TIMING);
  session.roundEndsAt = Date.now() + durationMs;

  // Broadcast round start to all clients (answer coords stripped)
  const clientRound = sanitiseRoundForClient(round);
  io.to(roomCode).emit(EVENTS.S_ROUND_START, {
    round:       clientRound,
    roundIndex:  session.currentIndex,
    totalRounds: session.sequence.length,
    durationMs,
    endsAt:      session.roundEndsAt,
  });

  logger.info(
    {
      roomCode,
      roundId:    round.id,
      roundType:  round.type,
      roundIndex: session.currentIndex,
      durationMs,
    },
    'Round started'
  );

  // ── Tick timer: broadcast remaining time every second ──────────────────

  session.tickTimer = setInterval(() => {
    const remaining = Math.max(0, session.roundEndsAt - Date.now());
    io.to(roomCode).emit(EVENTS.S_ROUND_TICK, {
      remainingMs: remaining,
      roundIndex:  session.currentIndex,
    });
    if (remaining === 0) {
      // Interval will be cleared by _endRound
      clearInterval(session.tickTimer);
      session.tickTimer = null;
    }
  }, 1_000);

  // ── Round timer: auto-end round when time expires ─────────────────────

  session.roundTimer = setTimeout(
    () => _endRound(roomCode, io),
    durationMs
  );
}

/**
 * End the current round, score all guesses, broadcast reveal.
 * Transitions: ROUND_ACTIVE → ROUND_REVEAL → LEADERBOARD
 *
 * @param {string}             roomCode
 * @param {SocketIO.Namespace} io
 */
function _endRound(roomCode, io) {
  const room    = rooms.getRoom(roomCode);
  const session = _getSession(roomCode);

  // Guard: if state already moved on (e.g. host force-advanced), bail out
  if (room.state !== GAME_STATE.ROUND_ACTIVE) return;

  _clearTimers(session);

  room.state = GAME_STATE.ROUND_REVEAL;

  const round      = getRound(session.sequence, session.currentIndex);
  const allIds     = [...room.players.values()].map((p) => p.id);
  const guessArray = [...session.guesses.values()].map((g) => ({
    playerId: g.playerId,
    coord:    g.coord,
  }));

  // ── Score ─────────────────────────────────────────────────────────────

  const answer = round.type === ROUND_TYPE.WORLD
    ? { lat: round.lat, lng: round.lng }
    : { x: round.x,    y: round.y    };

  const { scores, noGuessList } = scoreRound(
    round.type,
    answer,
    guessArray,
    allIds
  );

  // ── Apply scores to persistent player objects ──────────────────────────

  for (const scored of scores) {
    rooms.addScore(roomCode, scored.playerId, scored.points);
  }
  // No-guess players get 0 — no addScore call needed

  // ── Build and broadcast reveal payload ────────────────────────────────

  const leaderboard    = buildLeaderboard(room.players, scores, noGuessList);
  const revealPayload  = buildRevealPayload(
    answer,
    scores,
    noGuessList,
    leaderboard,
    session.currentIndex,
    session.sequence.length
  );

  // Include the location hint and round metadata in the reveal
  revealPayload.locationHint = round.locationHint ?? null;
  revealPayload.roundType    = round.type;
  revealPayload.roundLabel   = round.label;

  io.to(roomCode).emit(EVENTS.S_ROUND_REVEAL, revealPayload);

  logger.info(
    {
      roomCode,
      roundIndex: session.currentIndex,
      guessCount: guessArray.length,
      noGuessCount: noGuessList.length,
    },
    'Round ended — reveal broadcast'
  );

  // ── Transition to leaderboard after reveal duration ───────────────────

  setTimeout(() => _showLeaderboard(roomCode, io), TIMING.REVEAL_DURATION_MS);
}

/**
 * Show the leaderboard screen between rounds (or as final screen).
 * Transitions: ROUND_REVEAL → LEADERBOARD
 *
 * @param {string}             roomCode
 * @param {SocketIO.Namespace} io
 */
function _showLeaderboard(roomCode, io) {
  const room    = rooms.getRoom(roomCode);
  const session = _getSession(roomCode);

  room.state = GAME_STATE.LEADERBOARD;

  const snapshot    = rooms.getPlayerSnapshot(roomCode);
  const isLastRound = session.currentIndex === session.sequence.length - 1;

  io.to(roomCode).emit(EVENTS.S_LEADERBOARD, {
    players:     snapshot,
    roundIndex:  session.currentIndex,
    totalRounds: session.sequence.length,
    isLastRound,
  });

  logger.info(
    { roomCode, roundIndex: session.currentIndex, isLastRound },
    'Leaderboard shown'
  );

  if (isLastRound) {
    // Linger longer on the final leaderboard
    setTimeout(() => _endGame(roomCode, io), TIMING.FINAL_LEADERBOARD_DURATION_MS);
  } else {
    // Countdown into next round
    setTimeout(() => {
      room.state = GAME_STATE.ROUND_COUNTDOWN;
      io.to(roomCode).emit(EVENTS.S_GAME_COUNTDOWN, {
        countdownMs: TIMING.ROUND_COUNTDOWN_MS,
        totalRounds: session.sequence.length,
      });
      setTimeout(() => _startRound(roomCode, io), TIMING.ROUND_COUNTDOWN_MS);
    }, TIMING.LEADERBOARD_DURATION_MS);
  }
}

/**
 * End the game entirely.
 * Transitions: LEADERBOARD → GAME_OVER
 *
 * @param {string}             roomCode
 * @param {SocketIO.Namespace} io
 */
function _endGame(roomCode, io) {
  const room = rooms.getRoom(roomCode);
  room.state = GAME_STATE.GAME_OVER;

  const finalLeaderboard = rooms.getPlayerSnapshot(roomCode);

  io.to(roomCode).emit(EVENTS.S_GAME_OVER, {
    leaderboard: finalLeaderboard,
    podium:      finalLeaderboard.slice(0, 3),
  });

  logger.info({ roomCode }, 'Game over — final results broadcast');

  // Schedule room cleanup and destroy session
  rooms.schedulePostGameCleanup(roomCode);
  destroySession(roomCode);
}

// ─── Host Controls ────────────────────────────────────────────────────────────

/**
 * Allow the host to manually advance past the current reveal/leaderboard
 * and immediately start the next round (or end the game).
 * Useful if the host wants to control pacing at the event.
 *
 * Only valid during ROUND_REVEAL or LEADERBOARD states.
 *
 * @param {string}             roomCode
 * @param {SocketIO.Namespace} io
 */
function hostAdvance(roomCode, io) {
  const room    = rooms.getRoom(roomCode);
  const session = _getSession(roomCode);

  _assertState(room, GAME_STATE.ROUND_REVEAL, GAME_STATE.LEADERBOARD);
  _clearTimers(session);

  const isLastRound = session.currentIndex === session.sequence.length - 1;

  logger.info(
    { roomCode, currentState: room.state, isLastRound },
    'Host manually advanced round'
  );

  if (isLastRound && room.state === GAME_STATE.LEADERBOARD) {
    _endGame(roomCode, io);
  } else if (room.state === GAME_STATE.ROUND_REVEAL) {
    _showLeaderboard(roomCode, io);
  } else {
    // LEADERBOARD and not last round
    room.state = GAME_STATE.ROUND_COUNTDOWN;
    io.to(roomCode).emit(EVENTS.S_GAME_COUNTDOWN, {
      countdownMs: TIMING.ROUND_COUNTDOWN_MS,
      totalRounds: session.sequence.length,
    });
    setTimeout(() => _startRound(roomCode, io), TIMING.ROUND_COUNTDOWN_MS);
  }
}

// ─── Guess Handling ───────────────────────────────────────────────────────────

/**
 * Record a player's guess for the current round.
 * Silently no-ops if the player already guessed (first guess wins).
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @param {Object} coord      WorldCoord or PixelCoord
 * @param {SocketIO.Namespace} io
 * @returns {{ accepted: boolean, guessCount: number, totalPlayers: number }}
 */
function submitGuess(roomCode, playerId, coord, io) {
  const room    = rooms.getRoom(roomCode);
  const session = _getSession(roomCode);

  if (room.state !== GAME_STATE.ROUND_ACTIVE) {
    throw new GameError(
      'Cannot submit a guess — no round is currently active',
      ERROR_CODE.ROUND_NOT_ACTIVE
    );
  }

  // First guess only — subsequent attempts from same player are silently ignored
  if (session.guesses.has(playerId)) {
    return {
      accepted:     false,
      guessCount:   session.guesses.size,
      totalPlayers: room.players.size,
    };
  }

  session.guesses.set(playerId, {
    playerId,
    coord,
    submittedAt: Date.now(),
  });

  const guessCount   = session.guesses.size;
  const totalPlayers = [...room.players.values()].filter(
    (p) => p.role === ROLE.PLAYER
  ).length;

  // Broadcast live guess count to host display
  io.to(roomCode).emit(EVENTS.S_GUESS_COUNT, {
    guessCount,
    totalPlayers,
    roundIndex: session.currentIndex,
  });

  logger.debug(
    { roomCode, playerId, guessCount, totalPlayers },
    'Guess recorded'
  );

  // Auto-end round early if everyone has guessed
  if (guessCount >= totalPlayers) {
    logger.info(
      { roomCode, guessCount },
      'All players guessed — ending round early'
    );
    _clearTimers(session);
    // Small delay so the last guesser sees their pin land before reveal
    setTimeout(() => _endRound(roomCode, io), 800);
  }

  return { accepted: true, guessCount, totalPlayers };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  initialise,
  startGame,
  submitGuess,
  hostAdvance,
  destroySession,
};