'use strict';

const fs   = require('fs');
const path = require('path');

const logger = require('./logger');
const { ROUND_TYPE } = require('./constants');
const { AppError, ERROR_CODE } = require('./errors');

// ─── Types (JSDoc) ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} WorldRound
 * @property {string} id              Unique round identifier
 * @property {'world'} type
 * @property {string} label           Shown on host display e.g. "Round 3 — World"
 * @property {string} panoId          Mapillary image/sequence ID for the panorama viewer
 * @property {string} [previewUrl]    Optional static thumbnail for loading screen
 * @property {number} lat             Correct answer latitude
 * @property {number} lng             Correct answer longitude
 * @property {string} [locationHint]  Revealed AFTER the round e.g. "Paris, France"
 * @property {number} [durationMs]    Override default world round timer
 */

/**
 * @typedef {Object} CampusRound
 * @property {string}  id
 * @property {'campus'} type
 * @property {string}  label           e.g. "Round 7 — Campus"
 * @property {string}  photoUrl        Path or URL to the 360° campus photo
 * @property {number}  x               Correct answer normalised X (0-1)
 * @property {number}  y               Correct answer normalised Y (0-1)
 * @property {string}  [locationHint]  Revealed after round e.g. "Central Library Courtyard"
 * @property {number}  [durationMs]    Override default campus round timer
 */

/**
 * @typedef {WorldRound|CampusRound} Round
 */

// ─── Data Paths ───────────────────────────────────────────────────────────────

const DATA_DIR         = path.join(__dirname, 'data');
const WORLD_ROUNDS_PATH  = path.join(DATA_DIR, 'worldRounds.json');
const CAMPUS_ROUNDS_PATH = path.join(DATA_DIR, 'campusRounds.json');

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a single world round definition.
 * Throws a descriptive error on the first failed field.
 *
 * @param {*}      raw    Parsed JSON object
 * @param {number} index  Position in the array (for error messages)
 */
function _validateWorldRound(raw, index) {
  const prefix = `worldRounds[${index}]`;

  _assert(typeof raw.id     === 'string' && raw.id.trim(),    `${prefix}.id must be a non-empty string`);
  _assert(raw.type === ROUND_TYPE.WORLD,                       `${prefix}.type must be "world"`);
  _assert(typeof raw.label  === 'string' && raw.label.trim(), `${prefix}.label must be a non-empty string`);
  _assert(typeof raw.panoId === 'string' && raw.panoId.trim(),`${prefix}.panoId must be a non-empty string`);

  _assert(
    typeof raw.lat === 'number' && raw.lat >= -90  && raw.lat <= 90,
    `${prefix}.lat must be a number in [-90, 90]`
  );
  _assert(
    typeof raw.lng === 'number' && raw.lng >= -180 && raw.lng <= 180,
    `${prefix}.lng must be a number in [-180, 180]`
  );

  if (raw.durationMs !== undefined) {
    _assert(
      typeof raw.durationMs === 'number' && raw.durationMs >= 5_000,
      `${prefix}.durationMs must be a number >= 5000 ms`
    );
  }
}

/**
 * Validate a single campus round definition.
 *
 * @param {*}      raw
 * @param {number} index
 */
function _validateCampusRound(raw, index) {
  const prefix = `campusRounds[${index}]`;

  _assert(typeof raw.id       === 'string' && raw.id.trim(),      `${prefix}.id must be a non-empty string`);
  _assert(raw.type === ROUND_TYPE.CAMPUS,                          `${prefix}.type must be "campus"`);
  _assert(typeof raw.label    === 'string' && raw.label.trim(),   `${prefix}.label must be a non-empty string`);
  _assert(typeof raw.photoUrl === 'string' && raw.photoUrl.trim(),`${prefix}.photoUrl must be a non-empty string`);

  _assert(
    typeof raw.x === 'number' && raw.x >= 0 && raw.x <= 1,
    `${prefix}.x must be a number in [0, 1]`
  );
  _assert(
    typeof raw.y === 'number' && raw.y >= 0 && raw.y <= 1,
    `${prefix}.y must be a number in [0, 1]`
  );

  if (raw.durationMs !== undefined) {
    _assert(
      typeof raw.durationMs === 'number' && raw.durationMs >= 5_000,
      `${prefix}.durationMs must be a number >= 5000 ms`
    );
  }
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Load, parse and validate all rounds from disk.
 * Called once at startup — rounds are immutable for the lifetime of the process.
 * Throws loudly on any validation error so bad data never reaches a live game.
 *
 * @returns {Round[]}  Ordered array of all rounds (world + campus interleaved as authored)
 */
function loadRounds() {
  const worldRaw  = _readJsonFile(WORLD_ROUNDS_PATH,  'worldRounds.json');
  const campusRaw = _readJsonFile(CAMPUS_ROUNDS_PATH, 'campusRounds.json');

  // ── Validate ───────────────────────────────────────────────────────────────

  _assert(Array.isArray(worldRaw),  'worldRounds.json must export a JSON array');
  _assert(Array.isArray(campusRaw), 'campusRounds.json must export a JSON array');
  _assert(worldRaw.length  > 0,     'worldRounds.json must contain at least one round');
  _assert(campusRaw.length > 0,     'campusRounds.json must contain at least one round');

  worldRaw.forEach(_validateWorldRound);
  campusRaw.forEach(_validateCampusRound);

  // ── ID uniqueness across both files ───────────────────────────────────────

  const allRaw = [...worldRaw, ...campusRaw];
  const ids    = allRaw.map((r) => r.id);
  const dupes  = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    throw new AppError(
      `Duplicate round IDs detected: ${[...new Set(dupes)].join(', ')}`,
      ERROR_CODE.INTERNAL
    );
  }

  logger.info(
    { worldCount: worldRaw.length, campusCount: campusRaw.length },
    'Rounds loaded and validated'
  );

  // Return the two arrays separately so gameState can interleave them
  // in whatever order it wants rather than locking to file order.
  return { worldRounds: worldRaw, campusRounds: campusRaw };
}

// ─── Round Sequencing ─────────────────────────────────────────────────────────

/**
 * Build the final ordered round sequence for a game session.
 *
 * Default interleave strategy:
 *   - World rounds first (easier warm-up, no local knowledge required)
 *   - Campus rounds in the second half (home crowd advantage + familiarity)
 *   - Campus rounds are shuffled so players who know the data file can't predict order
 *
 * @param {WorldRound[]}  worldRounds
 * @param {CampusRound[]} campusRounds
 * @param {Object}        [options]
 * @param {number}        [options.maxWorldRounds]   Cap how many world rounds to use
 * @param {number}        [options.maxCampusRounds]  Cap how many campus rounds to use
 * @param {boolean}       [options.shuffleCampus=true]
 * @param {boolean}       [options.shuffleWorld=false]
 * @returns {Round[]}
 */
function buildRoundSequence(worldRounds, campusRounds, options = {}) {
  const {
    maxWorldRounds  = worldRounds.length,
    maxCampusRounds = campusRounds.length,
    shuffleCampus   = true,
    shuffleWorld    = false,
  } = options;

  let world  = worldRounds.slice(0, maxWorldRounds);
  let campus = campusRounds.slice(0, maxCampusRounds);

  if (shuffleWorld)  world  = _shuffle(world);
  if (shuffleCampus) campus = _shuffle(campus);

  const sequence = [...world, ...campus];

  logger.info(
    { worldCount: world.length, campusCount: campus.length, total: sequence.length },
    'Round sequence built'
  );

  return sequence;
}

/**
 * Get a single round by its 0-based index in the sequence.
 * Returns null if index is out of bounds (game over condition).
 *
 * @param {Round[]} sequence
 * @param {number}  index
 * @returns {Round|null}
 */
function getRound(sequence, index) {
  return sequence[index] ?? null;
}

/**
 * Get the effective duration for a round in milliseconds.
 * Respects the per-round override if present, otherwise uses the global constant.
 *
 * @param {Round}  round
 * @param {Object} timing   TIMING constant object
 * @returns {number}
 */
function getRoundDuration(round, timing) {
  if (round.durationMs) return round.durationMs;
  return round.type === ROUND_TYPE.WORLD
    ? timing.WORLD_ROUND_DURATION_MS
    : timing.CAMPUS_ROUND_DURATION_MS;
}

/**
 * Return a client-safe version of a round (strips the correct answer coordinates).
 * This is what gets broadcast to players at round start —
 * never send lat/lng or x/y to clients before the reveal.
 *
 * @param {Round} round
 * @returns {Object}
 */
function sanitiseRoundForClient(round) {
  if (round.type === ROUND_TYPE.WORLD) {
    const { lat, lng, ...safe } = round; // eslint-disable-line no-unused-vars
    return safe;
  }

  if (round.type === ROUND_TYPE.CAMPUS) {
    const { x, y, ...safe } = round; // eslint-disable-line no-unused-vars
    return safe;
  }

  return round;
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Read and JSON-parse a file synchronously.
 * Using sync read is intentional — this only runs once at startup,
 * not inside any request/event handler.
 *
 * @param {string} filePath
 * @param {string} name      For error messages
 * @returns {*}
 */
function _readJsonFile(filePath, name) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new AppError(
        `Round data file not found: ${filePath}. ` +
        `Create ${name} in server/data/ before starting the server.`,
        ERROR_CODE.INTERNAL
      );
    }
    if (err instanceof SyntaxError) {
      throw new AppError(
        `Invalid JSON in ${name}: ${err.message}`,
        ERROR_CODE.INTERNAL
      );
    }
    throw err;
  }
}

/**
 * Inline assertion helper — throws AppError with a clear message.
 *
 * @param {boolean} condition
 * @param {string}  message
 */
function _assert(condition, message) {
  if (!condition) {
    throw new AppError(`Round validation failed: ${message}`, ERROR_CODE.INTERNAL);
  }
}

/**
 * Fisher-Yates shuffle — returns a new array, does not mutate input.
 *
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
function _shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  loadRounds,
  buildRoundSequence,
  getRound,
  getRoundDuration,
  sanitiseRoundForClient,
};