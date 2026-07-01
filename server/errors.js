'use strict';

/**
 * Base class for all application-level errors.
 * Attach a `code` string so the client can handle specific error types.
 */
class AppError extends Error {
  /**
   * @param {string} message  Human-readable description
   * @param {string} code     Machine-readable error code (SCREAMING_SNAKE_CASE)
   * @param {number} [statusCode=400] HTTP status code if surfaced via REST
   */
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** Errors related to room lifecycle */
class RoomError extends AppError {
  constructor(message, code) {
    super(message, code, 400);
  }
}

/** Errors related to game state transitions */
class GameError extends AppError {
  constructor(message, code) {
    super(message, code, 400);
  }
}

/** Errors related to socket payload validation */
class ValidationError extends AppError {
  /**
   * @param {string} message
   * @param {import('zod').ZodIssue[]} [issues]
   */
  constructor(message, issues = []) {
    super(message, 'VALIDATION_ERROR', 400);
    this.issues = issues;
  }
}

/** Errors related to authorization (non-host trying to do host actions) */
class AuthError extends AppError {
  constructor(message) {
    super(message, 'UNAUTHORIZED', 403);
  }
}

// ─── Error Codes ──────────────────────────────────────────────────────────────

const ERROR_CODE = Object.freeze({
  // Room
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_ALREADY_STARTED: 'ROOM_ALREADY_STARTED',
  NICKNAME_TAKEN: 'NICKNAME_TAKEN',

  // Game
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  ROUND_NOT_ACTIVE: 'ROUND_NOT_ACTIVE',
  ALREADY_GUESSED: 'ALREADY_GUESSED',
  NOT_ENOUGH_PLAYERS: 'NOT_ENOUGH_PLAYERS',
  ROUNDS_EXHAUSTED: 'ROUNDS_EXHAUSTED',

  // Auth
  UNAUTHORIZED: 'UNAUTHORIZED',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  // Generic
  INTERNAL: 'INTERNAL_SERVER_ERROR',
});

module.exports = {
  AppError,
  RoomError,
  GameError,
  ValidationError,
  AuthError,
  ERROR_CODE,
};