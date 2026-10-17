'use strict';

const logger  = require('./logger');
const config  = require('./config');
const { saveTop10 } = require('./results');
const {
  GAME_STATE,
  TIMING,
  EVENTS,
  ROUND_TYPE,
  ROLE,
} = require('./constants');
const { GameError, ERROR_CODE } = require('./errors');
const {
  loadRounds,
  buildRoundSequence,
  getRound,
  getRoundDuration,
  sanitiseRoundForClient,
} = require('./rounds');
const { scoreRound, buildLeaderboard, buildRevealPayload } = require('./scoring');
const rooms = require('./rooms');
const { writeCheckpoint, buildCheckpoint, deleteCheckpoint } = require('./persistence');

// ─── Module-level round data (loaded once at startup) ─────────────────────────

let _worldRounds  = null;
let _campusRounds = null;

/**
 * Load round data from disk.
 * Must be called once before any game can start.
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

// ─── Singleton Session ────────────────────────────────────────────────────────

/**
 * @typedef {Object} GameSession
 * @property {Round[]}                sequence
 * @property {string[]}               roundIds         Ordered round IDs (persist in checkpoint)
 * @property {number}                 currentIndex     0-based (-1 = not started)
 * @property {Map<string, RawGuess>}  guesses          playerId → guess for current round
 * @property {NodeJS.Timeout|null}    tickTimer
 * @property {NodeJS.Timeout|null}    transitionTimer  The single pending phase-change timer
 * @property {number|null}            roundEndsAt      Unix ms when current round expires
 * @property {number}                 roundDurationMs
 * @property {boolean}                roundClosing     True once the round is guaranteed to end
 * @property {boolean}                resumed          True if restored from a checkpoint
 */

/** @type {GameSession|null} */
let _session = null;

// ─── Session Helpers ──────────────────────────────────────────────────────────

/**
 * Get the active session or throw.
 *
 * @returns {GameSession}
 */
function _getSession() {
  if (!_session) {
    throw new GameError(
      'No active game session',
      ERROR_CODE.INVALID_STATE_TRANSITION
    );
  }
  return _session;
}

/**
 * Rebuild a sequence from a saved list of round IDs.
 * Returns null if any ID can no longer be found.
 *
 * @param {string[]} roundIds
 * @returns {Round[]|null}
 */
function _rebuildSequence(roundIds) {
  const byId = new Map();
  for (const r of [..._worldRounds, ..._campusRounds]) byId.set(r.id, r);

  const sequence = [];
  for (const id of roundIds) {
    const round = byId.get(id);
    if (!round) return null;
    sequence.push(round);
  }
  return sequence;
}

/**
 * Create a fresh session.
 *
 * @param {Object}   [opts]
 * @param {number}   [opts.resumeFromIndex=-1]  Last completed round index
 * @param {string[]} [opts.roundIds]            Saved round order to restore
 * @returns {GameSession}
 */
function _createSession({ resumeFromIndex = -1, roundIds = null } = {}) {
  // Make sure nothing from an earlier session can still fire
  _clearTimers();

  let sequence = null;

  if (Array.isArray(roundIds) && roundIds.length > 0) {
    sequence = _rebuildSequence(roundIds);
    if (!sequence) {
      logger.warn('Saved round order no longer matches round data — building a new sequence');
    }
  }

  if (!sequence) {
    sequence = buildRoundSequence(_worldRounds, _campusRounds, {
      maxWorldRounds:  config.MAX_WORLD_ROUNDS,
      maxCampusRounds: config.MAX_CAMPUS_ROUNDS,
      shuffleCampus:   false,
      shuffleWorld:    false,
    });
  }

  _session = {
    sequence,
    roundIds:        sequence.map((r) => r.id),
    currentIndex:    resumeFromIndex,
    guesses:         new Map(),
    tickTimer:       null,
    transitionTimer: null,
    roundEndsAt:     null,
    roundDurationMs: 0,
    roundClosing:    false,
    resumed:         false,
  };

  return _session;
}

/**
 * Clear all active timers. Leaves roundEndsAt intact so state syncs
 * during reveal/leaderboard still have the last value available.
 */
function _clearTimers() {
  if (!_session) return;
  if (_session.tickTimer) {
    clearInterval(_session.tickTimer);
    _session.tickTimer = null;
  }
  if (_session.transitionTimer) {
    clearTimeout(_session.transitionTimer);
    _session.transitionTimer = null;
  }
}

/**
 * Schedule the single pending phase-change callback.
 * - Replaces any previously scheduled one
 * - Skips silently if the session was destroyed or replaced
 * - Catches errors so a timer callback can never crash the process
 *
 * @param {Function} fn
 * @param {number}   ms
 */
function _schedule(fn, ms) {
  const session = _session;
  if (!session) return;

  if (session.transitionTimer) {
    clearTimeout(session.transitionTimer);
  }

  session.transitionTimer = setTimeout(() => {
    if (_session !== session) return;
    session.transitionTimer = null;
    try {
      fn();
    } catch (err) {
      logger.error({ err }, 'Game timer callback failed');
    }
  }, ms);
}

/**
 * Destroy the session entirely.
 */
function destroySession() {
  _clearTimers();
  _session = null;
  logger.info('Game session destroyed');
}

// ─── State Guard ──────────────────────────────────────────────────────────────

/**
 * Assert room is in one of the expected states.
 *
 * @param {import('./rooms').Room} room
 * @param {...string} expectedStates
 */
function _assertState(room, ...expectedStates) {
  if (!expectedStates.includes(room.state)) {
    throw new GameError(
      `Invalid state transition: room is "${room.state}", ` +
      `expected one of [${expectedStates.join(', ')}]`,
      ERROR_CODE.INVALID_STATE_TRANSITION
    );
  }
}

// ─── Checkpoint Helper ────────────────────────────────────────────────────────

/**
 * Write a checkpoint at safe boundaries (round end, game over).
 * Non-blocking — errors are logged but never thrown.
 *
 * NOTE: buildCheckpoint() must persist `session.roundIds` so that
 * resumeFromCheckpoint() can restore the exact same round order.
 *
 * @param {import('./rooms').Room} room
 */
function _checkpoint(room) {
  const session    = _session;
  const adminToken = rooms.getAdminToken();
  if (!adminToken || !session) return;

  try {
    const data = buildCheckpoint(room, session, adminToken);
    Promise.resolve(writeCheckpoint(data)).catch(() => {}); // logged inside writeCheckpoint
  } catch (err) {
    logger.error({ err }, 'Failed to build checkpoint');
  }
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Connected, non-host players.
 *
 * @returns {Object[]}
 */
function _connectedPlayers() {
  const room = rooms.getRoomOrNull();
  if (!room) return [];
  return [...room.players.values()].filter(
    (p) => p.role === ROLE.PLAYER && p.connected !== false
  );
}

/**
 * Count connected non-host players.
 *
 * @returns {number}
 */
function _activePlayers() {
  return _connectedPlayers().length;
}

/**
 * Count guesses from currently connected players only.
 *
 * @param {GameSession} session
 * @returns {number}
 */
function _activeGuessCount(session) {
  const ids = new Set(_connectedPlayers().map((p) => p.id));
  let count = 0;
  for (const playerId of session.guesses.keys()) {
    if (ids.has(playerId)) count += 1;
  }
  return count;
}

// ─── Game Lifecycle ───────────────────────────────────────────────────────────

/**
 * Start a new game.
 * Transition: LOBBY → ROUND_COUNTDOWN → ROUND_ACTIVE
 *
 * @param {SocketIO.Server} io
 */
function startGame(io) {
  if (!_worldRounds) {
    throw new GameError('GameState not initialised', ERROR_CODE.INTERNAL);
  }

  const room = rooms.getRoom();
  _assertState(room, GAME_STATE.LOBBY);

  const playerCount = [...room.players.values()].filter(
    (p) => p.role === ROLE.PLAYER
  ).length;

  if (playerCount < 1) {
    throw new GameError('Cannot start with no players', ERROR_CODE.NOT_ENOUGH_PLAYERS);
  }

  _createSession();
  room.state = GAME_STATE.ROUND_COUNTDOWN;

  logger.info(
    { roomCode: room.code, totalRounds: _session.sequence.length, playerCount },
    'Game starting'
  );

  io.to(room.code).emit(EVENTS.S_GAME_COUNTDOWN, {
    countdownMs: TIMING.ROUND_COUNTDOWN_MS,
    totalRounds: _session.sequence.length,
  });

  _schedule(() => _startRound(io), TIMING.ROUND_COUNTDOWN_MS);
}

/**
 * Resume a game from a checkpoint (called on server restart).
 *
 * @param {number}          resumeIndex  Last completed roundIndex from checkpoint
 * @param {SocketIO.Server} io
 * @param {string[]}        [roundIds]   Round order saved in the checkpoint
 */
function resumeFromCheckpoint(resumeIndex, io, roundIds = null) {
  if (!_worldRounds) {
    throw new GameError('GameState not initialised', ERROR_CODE.INTERNAL);
  }

  const room = rooms.getRoom();

  _createSession({ resumeFromIndex: resumeIndex, roundIds });
  _session.resumed = true;

  logger.info(
    { roomCode: room.code, resumeIndex, totalRounds: _session.sequence.length },
    'Resuming game from checkpoint'
  );

  // LEADERBOARD lets the host advance manually to the next round
  room.state = GAME_STATE.LEADERBOARD;

  // The room is normally empty right after a restart, so this broadcast only
  // reaches anyone already connected. Reconnecting clients get the same info
  // through buildStateSync().
  io.to(room.code).emit(EVENTS.S_LEADERBOARD, {
    players:     rooms.getPlayerSnapshot(),
    roundIndex:  resumeIndex,
    totalRounds: _session.sequence.length,
    isLastRound: resumeIndex >= _session.sequence.length - 1,
    resumed:     true,
  });
}

// ─── Round Lifecycle ──────────────────────────────────────────────────────────

/**
 * Begin the next round.
 *
 * @param {SocketIO.Server} io
 */
function _startRound(io) {
  const room    = rooms.getRoom();
  const session = _getSession();

  session.currentIndex += 1;

  const round = getRound(session.sequence, session.currentIndex);
  if (!round) {
    _endGame(io);
    return;
  }

  // Reset per-round state
  session.guesses      = new Map();
  session.roundClosing = false;
  session.resumed      = false;

  room.state = GAME_STATE.ROUND_ACTIVE;

  const durationMs        = getRoundDuration(round, TIMING);
  session.roundDurationMs = durationMs;
  session.roundEndsAt     = Date.now() + durationMs;

  io.to(room.code).emit(EVENTS.S_ROUND_START, {
    round:       sanitiseRoundForClient(round),
    roundIndex:  session.currentIndex,
    totalRounds: session.sequence.length,
    durationMs,
    endsAt:      session.roundEndsAt,
  });

  logger.info(
    {
      roomCode:   room.code,
      roundId:    round.id,
      roundType:  round.type,
      roundIndex: session.currentIndex,
      durationMs,
    },
    'Round started'
  );

  // ── Tick timer — server is the authoritative clock ────────────────────
  // Clients display remainingMs from S_ROUND_TICK and never end a round
  // on their own.
  session.tickTimer = setInterval(() => {
    if (_session !== session) return;

    const remaining = Math.max(0, session.roundEndsAt - Date.now());

    io.to(room.code).emit(EVENTS.S_ROUND_TICK, {
      remainingMs: remaining,
      roundIndex:  session.currentIndex,
    });

    if (remaining === 0) {
      clearInterval(session.tickTimer);
      session.tickTimer = null;
    }
  }, 1_000);

  // ── Round expiry — scores the round, then shows the reveal ────────────
  _schedule(() => _endRound(io), durationMs);
}

/**
 * End the current round, score all guesses, broadcast reveal.
 * Transition: ROUND_ACTIVE → ROUND_REVEAL
 *
 * Only reachable from ROUND_ACTIVE, so a round can never be scored twice.
 *
 * @param {SocketIO.Server} io
 */
function _endRound(io) {
  const room    = rooms.getRoom();
  const session = _getSession();

  if (room.state !== GAME_STATE.ROUND_ACTIVE) return;

  _clearTimers();
  room.state = GAME_STATE.ROUND_REVEAL;

  const round  = getRound(session.sequence, session.currentIndex);
  const allIds = [...room.players.values()]
    .filter((p) => p.role === ROLE.PLAYER)
    .map((p) => p.id);
  const guessArray = [...session.guesses.values()].map((g) => ({
    playerId: g.playerId,
    coord:    g.coord,
  }));

  const answer = round.type === ROUND_TYPE.WORLD
    ? { lat: round.lat, lng: round.lng }
    : { x: round.x,    y: round.y    };

  const { scores, noGuessList } = scoreRound(
    round.type,
    answer,
    guessArray,
    allIds
  );

  for (const scored of scores) {
    rooms.addScore(scored.playerId, scored.points);
  }

  const leaderboard   = buildLeaderboard(room.players, scores, noGuessList);
  const revealPayload = buildRevealPayload(
    answer,
    scores,
    noGuessList,
    leaderboard,
    session.currentIndex,
    session.sequence.length
  );

  revealPayload.locationHint = round.locationHint ?? null;
  revealPayload.roundType    = round.type;
  revealPayload.roundLabel   = round.label;

  io.to(room.code).emit(EVENTS.S_ROUND_REVEAL, revealPayload);

  logger.info(
    {
      roomCode:     room.code,
      roundIndex:   session.currentIndex,
      guessCount:   guessArray.length,
      noGuessCount: noGuessList.length,
    },
    'Round ended — reveal broadcast'
  );

  _checkpoint(room);

  _schedule(() => _showLeaderboard(io), TIMING.REVEAL_DURATION_MS);
}

/**
 * Show leaderboard between rounds.
 * Transition: ROUND_REVEAL → LEADERBOARD
 *
 * @param {SocketIO.Server} io
 */
function _showLeaderboard(io) {
  const room    = rooms.getRoom();
  const session = _getSession();

  room.state = GAME_STATE.LEADERBOARD;

  const isLastRound = session.currentIndex === session.sequence.length - 1;

  io.to(room.code).emit(EVENTS.S_LEADERBOARD, {
    players:     rooms.getPlayerSnapshot(),
    roundIndex:  session.currentIndex,
    totalRounds: session.sequence.length,
    isLastRound,
  });

  logger.info(
    { roomCode: room.code, roundIndex: session.currentIndex, isLastRound },
    'Leaderboard shown'
  );

  if (isLastRound) {
    _schedule(() => _endGame(io), TIMING.FINAL_LEADERBOARD_DURATION_MS);
    return;
  }

  _schedule(() => _beginCountdown(io), TIMING.LEADERBOARD_DURATION_MS);
}

/**
 * Leaderboard → countdown → next round.
 * Shared by the automatic flow and hostAdvance().
 *
 * @param {SocketIO.Server} io
 */
function _beginCountdown(io) {
  const room    = rooms.getRoomOrNull();
  const session = _session;
  if (!room || !session) return;

  room.state = GAME_STATE.ROUND_COUNTDOWN;

  io.to(room.code).emit(EVENTS.S_GAME_COUNTDOWN, {
    countdownMs: TIMING.ROUND_COUNTDOWN_MS,
    totalRounds: session.sequence.length,
  });

  _schedule(() => _startRound(io), TIMING.ROUND_COUNTDOWN_MS);
}

/**
 * End the game entirely.
 * Transition: LEADERBOARD → GAME_OVER
 *
 * @param {SocketIO.Server} io
 */
function _endGame(io) {
  const room = rooms.getRoom();
  room.state = GAME_STATE.GAME_OVER;

  const finalLeaderboard = rooms.getPlayerSnapshot();

  const fixedLeaderboard = rooms.getPlayerSnapshot()
  .filter((p) => p.role !== ROLE.HOST)
  .sort((a, b) => b.score - a.score);

saveTop10(fixedLeaderboard);

  io.to(room.code).emit(EVENTS.S_GAME_OVER, {
    leaderboard: finalLeaderboard,
    podium:      finalLeaderboard.slice(0, 3),
  });

  logger.info({ roomCode: room.code }, 'Game over');

  // Game completed cleanly — no need to resume
  Promise.resolve(deleteCheckpoint()).catch(() => {});

  rooms.schedulePostGameCleanup();
  destroySession();
}

// ─── Host Controls ────────────────────────────────────────────────────────────

/**
 * Advance past reveal → leaderboard, or leaderboard → next round.
 * Only valid during ROUND_REVEAL or LEADERBOARD.
 * Does NOT handle ROUND_ACTIVE — use forceEndRound() for that.
 *
 * @param {SocketIO.Server} io
 */
function hostAdvance(io) {
  const room    = rooms.getRoom();
  const session = _getSession();

  _assertState(room, GAME_STATE.ROUND_REVEAL, GAME_STATE.LEADERBOARD);

  // Cancels the pending reveal→leaderboard / leaderboard→countdown timer
  _clearTimers();

  const isLastRound = session.currentIndex === session.sequence.length - 1;

  logger.info(
    { roomCode: room.code, state: room.state, isLastRound },
    'Host advanced'
  );

  if (room.state === GAME_STATE.ROUND_REVEAL) {
    _showLeaderboard(io);
  } else if (isLastRound) {
    _endGame(io);
  } else {
    _beginCountdown(io);
  }
}

/**
 * Force-end the currently active round immediately.
 *
 * @param {SocketIO.Server} io
 */
function forceEndRound(io) {
  const room = rooms.getRoom();
  _assertState(room, GAME_STATE.ROUND_ACTIVE);

  _endRound(io);
}

// ─── Guess Handling ───────────────────────────────────────────────────────────

/**
 * Record a player's guess. First guess wins — subsequent ones are silently ignored.
 *
 * @param {string}          playerId
 * @param {Object}          coord     WorldCoord | PixelCoord
 * @param {SocketIO.Server} io
 * @returns {{ accepted: boolean, guessCount: number, totalPlayers: number }}
 */
function submitGuess(playerId, coord, io) {
  const room    = rooms.getRoom();
  const session = _getSession();

  if (room.state !== GAME_STATE.ROUND_ACTIVE) {
    throw new GameError(
      'Cannot submit a guess — no active round',
      ERROR_CODE.ROUND_NOT_ACTIVE
    );
  }

    const round = getRound(session.sequence, session.currentIndex);
  const validShape = round && coord && (
    round.type === ROUND_TYPE.WORLD
      ? Number.isFinite(coord.lat) && Number.isFinite(coord.lng)
      : Number.isFinite(coord.x) && Number.isFinite(coord.y)
  );
  if (!validShape) {
    throw new GameError('Invalid guess for this round type', ERROR_CODE.VALIDATION_ERROR);
  }

  const totalPlayers = _activePlayers();

  // Duplicate guess, or the round is already closing
  if (session.guesses.has(playerId) || session.roundClosing) {
    return {
      accepted:     false,
      guessCount:   _activeGuessCount(session),
      totalPlayers,
    };
  }

  session.guesses.set(playerId, {
    playerId,
    coord,
    submittedAt: Date.now(),
  });

  const guessCount = _activeGuessCount(session);

  io.to(room.code).emit(EVENTS.S_GUESS_COUNT, {
    guessCount,
    totalPlayers,
    roundIndex: session.currentIndex,
  });

  logger.debug({ playerId, guessCount, totalPlayers }, 'Guess recorded');

  _closeRoundIfAllGuessed(io);

  return { accepted: true, guessCount, totalPlayers };
}

/**
 * End the round shortly if every connected player has guessed.
 * Room state stays ROUND_ACTIVE until _endRound() runs, so hostAdvance()
 * cannot skip scoring during the short delay.
 *
 * Also call this when a player disconnects mid-round.
 *
 * @param {SocketIO.Server} io
 */
function _closeRoundIfAllGuessed(io) {
  const room    = rooms.getRoomOrNull();
  const session = _session;
  if (!room || !session) return;
  if (room.state !== GAME_STATE.ROUND_ACTIVE || session.roundClosing) return;

  const totalPlayers = _activePlayers();
  if (totalPlayers < 1) return;
  if (_activeGuessCount(session) < totalPlayers) return;

  logger.info({ guessCount: _activeGuessCount(session) }, 'All players guessed — ending round early');

  session.roundClosing = true;
  _clearTimers();
  _schedule(() => _endRound(io), 500);
}

/**
 * Public hook: call after a player disconnects or leaves during a round.
 *
 * @param {SocketIO.Server} io
 */
function checkAllGuessed(io) {
  _closeRoundIfAllGuessed(io);
}

// ─── State Sync (for reconnecting clients) ────────────────────────────────────

/**
 * Build a full game state snapshot for a reconnecting client.
 * Sent via S_GAME_STATE_SYNC immediately after they rejoin.
 *
 * @param {string} [playerId]  If given, includes whether this player already guessed
 * @returns {Object|null}      null if no game is in progress
 */
function buildStateSync(playerId) {
  const room = rooms.getRoomOrNull();
  if (!room || !_session) return null;

  const session = _session;

  let currentRoundPayload = null;
  if (session.currentIndex >= 0) {
    const round = getRound(session.sequence, session.currentIndex);
    if (round) {
      currentRoundPayload = {
        round:       sanitiseRoundForClient(round),
        roundIndex:  session.currentIndex,
        totalRounds: session.sequence.length,
        durationMs:  session.roundDurationMs,
        endsAt:      room.state === GAME_STATE.ROUND_ACTIVE ? session.roundEndsAt : null,
      };
    }
  }

  return {
    gameState:   room.state,
    players:     rooms.getPlayerSnapshot(),
    roundIndex:  session.currentIndex,
    totalRounds: session.sequence.length,
    isLastRound: session.currentIndex === session.sequence.length - 1,
    resumed:     session.resumed,
    hasGuessed:  playerId ? session.guesses.has(playerId) : false,
    currentRoundPayload,
  };
}

// ─── Getters ──────────────────────────────────────────────────────────────────

/**
 * Get the current session without throwing.
 *
 * @returns {GameSession|null}
 */
function getSession() {
  return _session;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  initialise,
  startGame,
  resumeFromCheckpoint,
  submitGuess,
  checkAllGuessed,
  hostAdvance,
  forceEndRound,
  destroySession,
  getSession,
  buildStateSync,
};