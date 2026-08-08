'use strict';

const logger = require('./logger');
const { SCORING } = require('./constants');
const { calculateDistance } = require('./distance');

// ─── Types (JSDoc) ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RawGuess
 * @property {string} playerId
 * @property {Object} coord       WorldCoord or PixelCoord
 */

/**
 * @typedef {Object} ScoredGuess
 * @property {string} playerId
 * @property {Object} coord            The original guess coordinate
 * @property {number} distanceRaw      Raw distance (km for world, 0-1 for campus)
 * @property {number} distanceNorm     Normalised distance 0-1 (0 = perfect)
 * @property {string} distanceDisplay  Human readable e.g. "3.2 km"
 * @property {number} rank             1-based rank (1 = closest)
 * @property {number} points           Points awarded this round
 * @property {number} percentile       0-100, how well they did relative to field
 */

/**
 * @typedef {Object} RoundScoreResult
 * @property {ScoredGuess[]} scores       All guesses scored and ranked
 * @property {string[]}      noGuessList  Player IDs who did not submit a guess
 */

// ─── Core Scoring ─────────────────────────────────────────────────────────────

/**
 * Score all guesses for a completed round.
 *
 * Algorithm:
 *   1. Calculate geodesic/pixel distance for every guess.
 *   2. Sort by normalised distance ascending (closest first).
 *   3. Assign points using a smooth curve so the gap between
 *      rank 1 and rank 2 isn't disproportionately large.
 *   4. Players who did not guess receive NO_GUESS_POINTS (0).
 *
 * Points formula (percentile-based smooth curve):
 *   percentile = 1 - ((rank - 1) / totalGuessers)
 *   points     = MIN + (MAX - MIN) * percentile^CURVE
 *
 * The exponent (CURVE) controls how steep the reward dropoff is:
 *   - CURVE = 1 → perfectly linear distribution
 *   - CURVE < 1 → more players cluster near max (forgiving)
 *   - CURVE > 1 → points fall off faster toward the bottom (competitive)
 *
 * We use 0.7 — slightly forgiving so mid-field players aren't demoralised
 * in a 100-person lobby while still rewarding accuracy meaningfully.
 *
 * @param {string}     roundType   ROUND_TYPE.WORLD or ROUND_TYPE.CAMPUS
 * @param {Object}     answer      WorldCoord or PixelCoord of correct location
 * @param {RawGuess[]} guesses     All guesses submitted this round
 * @param {string[]}   allPlayerIds All player IDs in the room (to detect no-guesses)
 * @returns {RoundScoreResult}
 */
function scoreRound(roundType, answer, guesses, allPlayerIds) {
  const { MAX_POINTS_PER_ROUND, MIN_POINTS_PER_ROUND, NO_GUESS_POINTS } = SCORING;
  const CURVE = 0.7;

  // ── Step 1: Calculate distances ──────────────────────────────────────────

  const withDistances = guesses.map((g) => {
    const dist = calculateDistance(roundType, g.coord, answer);
    return {
      playerId: g.playerId,
      coord: g.coord,
      distanceRaw: dist.raw,
      distanceNorm: dist.normalised,
      distanceDisplay: dist.display,
    };
  });

  // ── Step 2: Sort ascending by normalised distance (closest first) ────────

  withDistances.sort((a, b) => a.distanceNorm - b.distanceNorm);

  // ── Step 3: Assign rank + points ─────────────────────────────────────────

  const totalGuessers = withDistances.length;

  /** @type {ScoredGuess[]} */
  const scores = withDistances.map((entry, index) => {
    const rank = index + 1;

    // percentile: rank 1 → 1.0, last rank → approaches 0
    const percentile = totalGuessers === 1
      ? 1                                         // sole guesser always gets max
      : 1 - (rank - 1) / (totalGuessers - 1);

    const points = Math.round(
      MIN_POINTS_PER_ROUND +
      (MAX_POINTS_PER_ROUND - MIN_POINTS_PER_ROUND) * Math.pow(percentile, CURVE)
    );

    return {
      ...entry,
      rank,
      points,
      percentile: _round(percentile * 100, 1), // store as 0-100 for display
    };
  });

  // ── Step 4: Identify players who did not guess ───────────────────────────

  const guessedIds = new Set(guesses.map((g) => g.playerId));
  const noGuessList = allPlayerIds.filter((id) => !guessedIds.has(id));

  logger.info(
    {
      roundType,
      totalGuessers,
      noGuessCount: noGuessList.length,
      topPlayer: scores[0]
        ? { playerId: scores[0].playerId, distanceDisplay: scores[0].distanceDisplay }
        : null,
    },
    'Round scored'
  );

  return { scores, noGuessList };
}

// ─── Leaderboard Snapshot ─────────────────────────────────────────────────────

/**
 * Build a full leaderboard from the room's player list.
 * Merges per-round scores with cumulative totals for display.
 *
 * @param {Map<string, import('./rooms').Player>} players   Room player map
 * @param {ScoredGuess[]} roundScores                       Scores from the just-completed round
 * @param {string[]}      noGuessList                       Players who didn't guess
 * @returns {LeaderboardEntry[]}
 */
function buildLeaderboard(players, roundScores, noGuessList) {
  // Index round scores by playerId for O(1) lookup
  const roundScoreMap = new Map(roundScores.map((s) => [s.playerId, s]));
  const noGuessSet    = new Set(noGuessList);

  /** @type {LeaderboardEntry[]} */
  const leaderboard = [...players.values()].map((player) => {
    const roundEntry = roundScoreMap.get(player.id);
    const didGuess   = !noGuessSet.has(player.id);

    return {
      playerId:        player.id,
      nickname:        player.nickname,
      totalScore:      player.score,             // already updated by gameState
      roundPoints:     roundEntry?.points  ?? SCORING.NO_GUESS_POINTS,
      roundRank:       roundEntry?.rank    ?? null,
      roundPercentile: roundEntry?.percentile ?? null,
      distanceDisplay: roundEntry?.distanceDisplay ?? null,
      didGuess,
      connected:       player.connected,
    };
  });

  // Sort by total score descending, then by nickname alphabetically for ties
  leaderboard.sort((a, b) =>
    b.totalScore - a.totalScore || a.nickname.localeCompare(b.nickname)
  );

  // Attach overall rank position (after sort)
  leaderboard.forEach((entry, i) => {
    entry.position = i + 1;
  });

  return leaderboard;
}

/**
 * @typedef {Object} LeaderboardEntry
 * @property {string}      playerId
 * @property {string}      nickname
 * @property {number}      totalScore
 * @property {number}      roundPoints
 * @property {number|null} roundRank
 * @property {number|null} roundPercentile
 * @property {string|null} distanceDisplay
 * @property {boolean}     didGuess
 * @property {boolean}     connected
 * @property {number}      position         1-based overall leaderboard position
 */

// ─── Reveal Payload Builder ───────────────────────────────────────────────────

/**
 * Build the payload broadcast to all clients at the end of a round.
 * Contains everything the frontend needs to run the pin reveal animation
 * and update the leaderboard.
 *
 * @param {Object}           answer       Correct coordinate
 * @param {ScoredGuess[]}    scores       All scored guesses
 * @param {string[]}         noGuessList
 * @param {LeaderboardEntry[]} leaderboard
 * @param {number}           roundIndex   0-based
 * @param {number}           totalRounds
 * @returns {RevealPayload}
 */
function buildRevealPayload(answer, scores, noGuessList, leaderboard, roundIndex, totalRounds) {
  return {
    answer,
    scores: scores.map((s) => ({
      playerId:        s.playerId,
      coord:           s.coord,
      distanceDisplay: s.distanceDisplay,
      distanceNorm:    s.distanceNorm,
      points:          s.points,
      rank:            s.rank,
      percentile:      s.percentile,
    })),
    noGuessList,
    leaderboard,
    roundIndex,
    totalRounds,
    isLastRound: roundIndex === totalRounds - 1,
    // Top 3 for the host display highlight moment
    podium: leaderboard.slice(0, 3).map((e) => ({
      position: e.position,
      nickname: e.nickname,
      totalScore: e.totalScore,
      roundPoints: e.roundPoints,
    })),
  };
}

/**
 * @typedef {Object} RevealPayload
 * @property {Object}           answer
 * @property {Object[]}         scores
 * @property {string[]}         noGuessList
 * @property {LeaderboardEntry[]} leaderboard
 * @property {number}           roundIndex
 * @property {number}           totalRounds
 * @property {boolean}          isLastRound
 * @property {Object[]}         podium
 */

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function _round(value, decimals) {
  return Number(value.toFixed(decimals));
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  scoreRound,
  buildLeaderboard,
  buildRevealPayload,
};