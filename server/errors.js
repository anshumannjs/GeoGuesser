'use strict';

class AppError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name        = this.constructor.name;
    this.code        = code;
    this.statusCode  = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

class RoomError extends AppError {
  constructor(message, code) { super(message, code, 400); }
}

class GameError extends AppError {
  constructor(message, code) { super(message, code, 400); }
}

class ValidationError extends AppError {
  constructor(message, issues = []) {
    super(message, 'VALIDATION_ERROR', 400);
    this.issues = issues;
  }
}

class AuthError extends AppError {
  constructor(message) { super(message, 'UNAUTHORIZED', 403); }
}

const ERROR_CODE = Object.freeze({
  // Room
  ROOM_NOT_FOUND:        'ROOM_NOT_FOUND',
  ROOM_FULL:             'ROOM_FULL',
  ROOM_ALREADY_STARTED:  'ROOM_ALREADY_STARTED',
  ROOM_ALREADY_EXISTS:   'ROOM_ALREADY_EXISTS',
  NICKNAME_TAKEN:        'NICKNAME_TAKEN',
  PLAYER_NOT_FOUND:      'PLAYER_NOT_FOUND',

  // Game
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  ROUND_NOT_ACTIVE:         'ROUND_NOT_ACTIVE',
  ALREADY_GUESSED:          'ALREADY_GUESSED',
  NOT_ENOUGH_PLAYERS:       'NOT_ENOUGH_PLAYERS',
  ROUNDS_EXHAUSTED:         'ROUNDS_EXHAUSTED',

  // Auth
  UNAUTHORIZED:    'UNAUTHORIZED',
  WRONG_PASSWORD:  'WRONG_PASSWORD',

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