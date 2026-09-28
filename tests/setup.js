'use strict';

// Set test environment variables BEFORE any server module is required
process.env.NODE_ENV              = 'test';
process.env.PORT                  = '3001';  // different from dev port
process.env.LOG_LEVEL             = 'silent';
process.env.MAPILLARY_CLIENT_TOKEN = 'test_token';
process.env.CORS_ORIGIN           = '*';
process.env.ROOM_TTL_MS           = '5000';  // short TTL for cleanup tests
process.env.MAX_WORLD_ROUNDS      = '2';
process.env.MAX_CAMPUS_ROUNDS     = '2';

// Silence pino logger during tests
jest.mock('../server/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  fatal: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));