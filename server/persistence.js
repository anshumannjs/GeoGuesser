'use strict';

const fs      = require('fs');
const path    = require('path');
const logger  = require('./logger');
const config  = require('./config');

// ─── Paths ────────────────────────────────────────────────────────────────────

const CHECKPOINT_PATH = path.resolve(config.CHECKPOINT_PATH);
const CHECKPOINT_TMP  = CHECKPOINT_PATH + '.tmp';

// ─── Types (JSDoc) ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PlayerSnapshot
 * @property {string} id
 * @property {string} nickname
 * @property {string} role
 * @property {number} score
 */

/**
 * @typedef {Object} Checkpoint
 * @property {number}           version       Schema version — increment when shape changes
 * @property {number}           savedAt       Unix ms timestamp
 * @property {string}           roomCode      The singleton room code
 * @property {string}           hostPlayerId  Stable host player ID
 * @property {string}           adminToken    Hashed admin token for host re-auth
 * @property {string}           state         GAME_STATE value at checkpoint time
 * @property {number}           roundIndex    0-based index of last completed round (-1 = not started)
 * @property {PlayerSnapshot[]} players       All players with their cumulative scores
 */

const CHECKPOINT_VERSION = 1;

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Write a game state checkpoint atomically to disk.
 *
 * Uses write-to-temp-then-rename pattern:
 *   1. Write full JSON to a .tmp file
 *   2. fsync the file descriptor (guarantees data hits disk)
 *   3. Rename .tmp → destination (atomic on all POSIX systems and Windows NTFS)
 *
 * If the server crashes between steps 1 and 3, the .tmp file is orphaned
 * and the previous checkpoint remains intact. Safe to call from anywhere.
 *
 * @param {Object} data  Checkpoint payload (see Checkpoint typedef)
 * @returns {Promise<void>}
 */
async function writeCheckpoint(data) {
  const payload = {
    version:  CHECKPOINT_VERSION,
    savedAt:  Date.now(),
    ...data,
  };

  const json = JSON.stringify(payload, null, 2);

  try {
    // Write to temp file first
    const fd = fs.openSync(CHECKPOINT_TMP, 'w');
    fs.writeSync(fd, json, 0, 'utf8');
    fs.fsyncSync(fd);   // guarantee data hits disk before rename
    fs.closeSync(fd);

    // Atomic rename — if this crashes, old checkpoint is still intact
    fs.renameSync(CHECKPOINT_TMP, CHECKPOINT_PATH);

    logger.debug(
      { path: CHECKPOINT_PATH, state: data.state, roundIndex: data.roundIndex },
      'Checkpoint written'
    );
  } catch (err) {
    // Non-fatal — log and continue. Game runs fine without persistence.
    logger.error({ err, path: CHECKPOINT_PATH }, 'Failed to write checkpoint');
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read and parse the checkpoint file from disk.
 * Returns null if no checkpoint exists or if it is corrupted/stale.
 *
 * Staleness check: if the checkpoint is older than ROOM_TTL_MS it is
 * considered expired and discarded — a crashed server that comes back
 * 2 hours later should not try to resume a game nobody is waiting for.
 *
 * @returns {Checkpoint|null}
 */
function readCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_PATH)) {
    logger.info({ path: CHECKPOINT_PATH }, 'No checkpoint file found — starting fresh');
    return null;
  }

  try {
    const raw  = fs.readFileSync(CHECKPOINT_PATH, 'utf8');
    const data = JSON.parse(raw);

    // Version guard — discard checkpoints from older schema versions
    if (data.version !== CHECKPOINT_VERSION) {
      logger.warn(
        { found: data.version, expected: CHECKPOINT_VERSION },
        'Checkpoint schema version mismatch — discarding'
      );
      deleteCheckpoint();
      return null;
    }

    // Staleness guard
    const ageMs = Date.now() - (data.savedAt ?? 0);
    if (ageMs > config.ROOM_TTL_MS) {
      logger.info(
        { ageMs, ttlMs: config.ROOM_TTL_MS },
        'Checkpoint expired — discarding'
      );
      deleteCheckpoint();
      return null;
    }

    logger.info(
      {
        roomCode:   data.roomCode,
        state:      data.state,
        roundIndex: data.roundIndex,
        players:    data.players?.length ?? 0,
        ageMs,
      },
      'Checkpoint loaded'
    );

    return data;

  } catch (err) {
    logger.error({ err, path: CHECKPOINT_PATH }, 'Checkpoint read/parse failed — discarding');
    deleteCheckpoint();
    return null;
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────

/**
 * Delete the checkpoint file.
 * Called after a game ends cleanly — no point recovering a finished game.
 *
 * @returns {void}
 */
function deleteCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      fs.unlinkSync(CHECKPOINT_PATH);
      logger.info({ path: CHECKPOINT_PATH }, 'Checkpoint deleted');
    }
    // Also clean up any orphaned tmp file
    if (fs.existsSync(CHECKPOINT_TMP)) {
      fs.unlinkSync(CHECKPOINT_TMP);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to delete checkpoint — non-fatal');
  }
}

// ─── Checkpoint Builder ───────────────────────────────────────────────────────

/**
 * Build a checkpoint payload from live room + session state.
 * Called by gameState.js at each safe checkpoint moment.
 *
 * @param {import('./rooms').Room}    room
 * @param {Object}                   session   GameSession from gameState
 * @param {string}                   adminToken
 * @returns {Checkpoint}
 */
function buildCheckpoint(room, session, adminToken) {
  return {
    roomCode:     room.code,
    hostPlayerId: room.hostPlayerId,
    adminToken,
    state:        room.state,
    roundIndex:   session?.currentIndex ?? -1,
    roundIds:     session?.roundIds ?? [],

    players:      [...room.players.values()].map((p) => ({
      id:        p.id,
      nickname:  p.nickname,
      role:      p.role,
      score:     p.score,
    })),
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  writeCheckpoint,
  readCheckpoint,
  deleteCheckpoint,
  buildCheckpoint,
};