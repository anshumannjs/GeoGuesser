'use strict';

const turf = require('@turf/turf');
const logger = require('./logger');
const { ROUND_TYPE } = require('./constants');

// ─── Types (JSDoc) ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} WorldCoord
 * @property {number} lat   Latitude  (-90  to  90)
 * @property {number} lng   Longitude (-180 to 180)
 */

/**
 * @typedef {Object} PixelCoord
 * @property {number} x  Normalised X (0.0 – 1.0, left → right)
 * @property {number} y  Normalised Y (0.0 – 1.0, top  → bottom)
 */

/**
 * @typedef {Object} DistanceResult
 * @property {number} raw        Raw distance value (km for world, 0-1 for campus)
 * @property {number} normalised Normalised 0-1 value (0 = perfect, 1 = worst possible)
 * @property {string} display    Human-readable string e.g. "3.2 km" or "~12% of map"
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum meaningful distance on Earth between two points (km).
 * Used to normalise world-round distances to 0-1.
 * Half the Earth's circumference ≈ 20,015 km.
 */
const EARTH_MAX_KM = 20_015;

/**
 * Maximum possible pixel distance on a unit square (diagonal = √2 ≈ 1.414).
 * Used to normalise campus distances to 0-1.
 */
const UNIT_SQUARE_DIAGONAL = Math.SQRT2;

// ─── World Round Distance (turf.js / geodesic) ───────────────────────────────

/**
 * Calculate the geodesic distance between two lat/lng coordinates.
 * Uses the WGS-84 ellipsoid via turf for accuracy.
 *
 * @param {WorldCoord} guess   Player's guessed coordinate
 * @param {WorldCoord} answer  Correct coordinate
 * @returns {DistanceResult}
 */
function worldDistance(guess, answer) {
  _validateWorldCoord(guess, 'guess');
  _validateWorldCoord(answer, 'answer');

  const guessPoint  = turf.point([guess.lng,  guess.lat]);
  const answerPoint = turf.point([answer.lng, answer.lat]);

  const km = turf.distance(guessPoint, answerPoint, { units: 'kilometers' });

  const normalised = Math.min(km / EARTH_MAX_KM, 1);

  return {
    raw: _round(km, 2),
    normalised: _round(normalised, 6),
    display: _formatKm(km),
  };
}

// ─── Campus Round Distance (2-D Euclidean on normalised pixel space) ──────────

/**
 * Calculate the Euclidean distance between two normalised pixel coordinates
 * on the campus map image.
 *
 * Both coordinates must be in [0, 1] range where (0,0) is top-left
 * and (1,1) is bottom-right of the campus map image.
 *
 * @param {PixelCoord} guess   Player's guessed coordinate
 * @param {PixelCoord} answer  Correct coordinate
 * @returns {DistanceResult}
 */
function campusDistance(guess, answer) {
  _validatePixelCoord(guess, 'guess');
  _validatePixelCoord(answer, 'answer');

  const dx  = guess.x - answer.x;
  const dy  = guess.y - answer.y;
  const raw = Math.sqrt(dx * dx + dy * dy);

  const normalised = Math.min(raw / UNIT_SQUARE_DIAGONAL, 1);

  return {
    raw: _round(raw, 6),
    normalised: _round(normalised, 6),
    display: _formatPixelPercent(normalised),
  };
}

// ─── Unified Entry Point ──────────────────────────────────────────────────────

/**
 * Calculate distance between a player's guess and the correct answer,
 * automatically dispatching to the right method based on round type.
 *
 * @param {string}            roundType  ROUND_TYPE.WORLD or ROUND_TYPE.CAMPUS
 * @param {WorldCoord|PixelCoord} guess
 * @param {WorldCoord|PixelCoord} answer
 * @returns {DistanceResult}
 */
function calculateDistance(roundType, guess, answer) {
  switch (roundType) {
    case ROUND_TYPE.WORLD:
      return worldDistance(
        /** @type {WorldCoord} */ (guess),
        /** @type {WorldCoord} */ (answer)
      );

    case ROUND_TYPE.CAMPUS:
      return campusDistance(
        /** @type {PixelCoord} */ (guess),
        /** @type {PixelCoord} */ (answer)
      );

    default:
      logger.error({ roundType }, 'calculateDistance called with unknown round type');
      throw new TypeError(`Unknown round type: "${roundType}"`);
  }
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Validate a world coordinate object.
 * Throws a descriptive TypeError on bad input rather than letting
 * turf silently produce NaN results.
 *
 * @param {*}      coord
 * @param {string} label  'guess' or 'answer' (for error messages)
 */
function _validateWorldCoord(coord, label) {
  if (
    coord === null ||
    typeof coord !== 'object' ||
    typeof coord.lat !== 'number' ||
    typeof coord.lng !== 'number' ||
    isNaN(coord.lat) ||
    isNaN(coord.lng) ||
    coord.lat  < -90  || coord.lat  >  90 ||
    coord.lng  < -180 || coord.lng  > 180
  ) {
    throw new TypeError(
      `Invalid world coordinate for "${label}": ` +
      `expected { lat: number [-90,90], lng: number [-180,180] }, got ${JSON.stringify(coord)}`
    );
  }
}

/**
 * Validate a normalised pixel coordinate object.
 *
 * @param {*}      coord
 * @param {string} label
 */
function _validatePixelCoord(coord, label) {
  if (
    coord === null ||
    typeof coord !== 'object' ||
    typeof coord.x !== 'number' ||
    typeof coord.y !== 'number' ||
    isNaN(coord.x) ||
    isNaN(coord.y) ||
    coord.x < 0 || coord.x > 1 ||
    coord.y < 0 || coord.y > 1
  ) {
    throw new TypeError(
      `Invalid pixel coordinate for "${label}": ` +
      `expected { x: number [0,1], y: number [0,1] }, got ${JSON.stringify(coord)}`
    );
  }
}

/**
 * Format a kilometre value for display.
 *
 * @param {number} km
 * @returns {string}
 */
function _formatKm(km) {
  if (km < 1)    return `${Math.round(km * 1000)} m`;
  if (km < 10)   return `${km.toFixed(1)} km`;
  if (km < 1000) return `${Math.round(km)} km`;
  return `${(km / 1000).toFixed(1)} k km`;
}

/**
 * Format a normalised pixel distance as a human-readable "% of map" string.
 * Shown on the reveal screen for campus rounds since raw pixel ratios
 * are meaningless to players.
 *
 * @param {number} normalised  0-1 value
 * @returns {string}
 */
function _formatPixelPercent(normalised) {
  const pct = Math.round(normalised * 100);
  if (pct === 0) return 'Spot on!';
  if (pct < 5)   return `~${pct}% of map away`;
  return `${pct}% of map away`;
}

/**
 * Round a number to a given number of decimal places.
 *
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function _round(value, decimals) {
  return Number(value.toFixed(decimals));
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  calculateDistance,
  worldDistance,
  campusDistance,
};