'use strict';

module.exports = {
  testEnvironment:   'node',
  testMatch:         ['**/tests/**/*.test.js'],
  setupFiles:        ['./tests/setup.js'],
  testTimeout:       15000,  // integration tests need more time
  // forceExit:        true,    // ensure Jest exits after tests complete
  collectCoverageFrom: [
    'server/**/*.js',
    '!server/index.js',      // bootstrap file — tested via integration
    '!server/logger.js',     // logging — not worth unit testing
  ],
  coverageThreshold: {
    global: {
      branches:   70,
      functions:  80,
      lines:      80,
      statements: 80,
    },
  },
  coverageReporters: ['text', 'lcov', 'html'],
  verbose: true,
};