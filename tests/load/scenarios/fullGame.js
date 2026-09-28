'use strict';

/**
 * Artillery scenario processor for load testing.
 * Provides custom functions used in artillery.yml.
 */

/**
 * Submit a random world coordinate guess.
 * Called by Artillery during the load test scenario.
 *
 * @param {Object} context   Artillery virtual user context
 * @param {Object} events    Artillery event emitter
 * @param {Function} done
 */
function submitGuess(context, events, done) {
  const socket = context.vars['$socket'];

  if (!socket) {
    events.emit('error', 'No socket available');
    return done();
  }

  // Random world coordinate
  const coord = {
    lat: (Math.random() * 180) - 90,
    lng: (Math.random() * 360) - 180,
  };

  socket.emit('c:guess:submit', {
    roomCode:   context.vars.roomCode ?? process.env.TEST_ROOM_CODE,
    roundIndex: context.vars.roundIndex ?? 0,
    coord,
  });

  done();
}

/**
 * Log scenario summary at the end of each virtual user lifecycle.
 *
 * @param {Object} context
 * @param {Object} events
 * @param {Function} done
 */
function logSummary(context, events, done) {
  console.log(
    `[VU] Events received: ${JSON.stringify(context.vars.receivedEvents ?? {})}`
  );
  done();
}

module.exports = { submitGuess, logSummary };