'use strict';

/**
 * Stress test: simulate N players joining simultaneously,
 * submitting guesses, and completing a full game cycle.
 *
 * Run with: node tests/stress/concurrentPlayers.js
 *
 * Prerequisites:
 *   1. Server must be running: npm run dev
 *   2. A host must have created a room (or use AUTO_CREATE=true env flag)
 *
 * Usage:
 *   PLAYER_COUNT=100 SERVER_URL=http://localhost:3000 node tests/stress/concurrentPlayers.js
 */

const { io: ClientIO } = require('socket.io-client');

// ── Config ────────────────────────────────────────────────────────────────────

const SERVER_URL    = process.env.SERVER_URL    ?? 'http://localhost:3000';
const PLAYER_COUNT  = parseInt(process.env.PLAYER_COUNT  ?? '100', 10);
const AUTO_CREATE   = process.env.AUTO_CREATE   === 'true';
const THINK_TIME_MS = parseInt(process.env.THINK_TIME_MS ?? '3000', 10);
const LOG_INTERVAL  = 10; // log progress every N players

// ── Metrics ───────────────────────────────────────────────────────────────────

const metrics = {
  connected:       0,
  joined:          0,
  guessSubmitted:  0,
  guessAcked:      0,
  revealReceived:  0,
  errors:          0,
  connectionTimes: [],
  guessTimes:      [],
  startTime:       Date.now(),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  const elapsed = ((Date.now() - metrics.startTime) / 1000).toFixed(1);
  console.log(`[${elapsed}s] ${msg}`);
}

function logMetrics() {
  const elapsed = (Date.now() - metrics.startTime) / 1000;
  const avgConnect = metrics.connectionTimes.length > 0
    ? (metrics.connectionTimes.reduce((a, b) => a + b, 0) / metrics.connectionTimes.length).toFixed(0)
    : 'N/A';
  const avgGuess = metrics.guessTimes.length > 0
    ? (metrics.guessTimes.reduce((a, b) => a + b, 0) / metrics.guessTimes.length).toFixed(0)
    : 'N/A';

  console.log('\n══════════════════════════════════════');
  console.log('         STRESS TEST RESULTS');
  console.log('══════════════════════════════════════');
  console.log(`Total players:          ${PLAYER_COUNT}`);
  console.log(`Connected:              ${metrics.connected}`);
  console.log(`Joined room:            ${metrics.joined}`);
  console.log(`Guesses submitted:      ${metrics.guessSubmitted}`);
  console.log(`Guess acks received:    ${metrics.guessAcked}`);
  console.log(`Reveals received:       ${metrics.revealReceived}`);
  console.log(`Errors:                 ${metrics.errors}`);
  console.log(`Avg connect time:       ${avgConnect}ms`);
  console.log(`Avg guess-to-ack time:  ${avgGuess}ms`);
  console.log(`Total elapsed:          ${elapsed.toFixed(1)}s`);
  console.log('══════════════════════════════════════\n');
}

function makeRandomCoord() {
  return {
    lat: (Math.random() * 180) - 90,
    lng: (Math.random() * 360) - 180,
  };
}

// ── Player simulation ─────────────────────────────────────────────────────────

/**
 * Simulate a single player's full game lifecycle.
 *
 * @param {string} roomCode
 * @param {number} index     Player number (for nickname)
 * @returns {Promise<void>}
 */
function simulatePlayer(roomCode, index) {
  return new Promise((resolve) => {
    const nickname = `StressPlayer${index}`;
    const connectStart = Date.now();

    const socket = ClientIO(SERVER_URL, {
      transports:           ['websocket'],
      reconnection:          false,
      timeout:               10000,
    });

    let roundIndex = -1;

    socket.on('connect', () => {
      metrics.connected++;
      metrics.connectionTimes.push(Date.now() - connectStart);

      if (metrics.connected % LOG_INTERVAL === 0) {
        log(`${metrics.connected}/${PLAYER_COUNT} connected`);
      }

      socket.emit('c:join', { roomCode, nickname });
    });

    socket.on('s:room:joined', () => {
      metrics.joined++;
    });

    socket.on('s:round:start', (payload) => {
      roundIndex = payload.roundIndex;

      // Simulate think time before guessing
      setTimeout(() => {
        const guessStart = Date.now();
        metrics.guessSubmitted++;

        socket.emit('c:guess:submit', {
          roomCode,
          roundIndex,
          coord: makeRandomCoord(),
        });

        socket.once('s:guess:ack', (ack) => {
          if (ack.accepted) {
            metrics.guessAcked++;
            metrics.guessTimes.push(Date.now() - guessStart);
          }
        });
      }, Math.random() * THINK_TIME_MS);
    });

    socket.on('s:round:reveal', () => {
      metrics.revealReceived++;
    });

    socket.on('s:game:over', () => {
      socket.disconnect();
      resolve();
    });

    socket.on('s:error', (err) => {
      // Ignore nickname conflicts from rapid reconnects
      if (err.code !== 'NICKNAME_TAKEN') {
        metrics.errors++;
        if (metrics.errors <= 5) { // only log first 5 to avoid spam
          log(`ERROR [${nickname}]: ${err.code} — ${err.message}`);
        }
      }
    });

    socket.on('connect_error', (err) => {
      metrics.errors++;
      log(`CONNECTION ERROR [${nickname}]: ${err.message}`);
      resolve(); // don't hang the test
    });

    socket.on('disconnect', () => {
      resolve();
    });

    // Safety timeout — resolve after 5 minutes regardless
    setTimeout(resolve, 5 * 60 * 1000);
  });
}

// ── Host simulation (optional) ────────────────────────────────────────────────

/**
 * Create a room as host, start the game, and advance through all rounds.
 *
 * @returns {Promise<string>} Room code
 */
function createHostAndRoom() {
  return new Promise((resolve, reject) => {
    const host = ClientIO(SERVER_URL, {
      transports:  ['websocket'],
      reconnection: false,
    });

    let roomCode;

    host.on('connect', () => {
      log('Host connected');
      host.emit('c:host:create', { nickname: 'StressTestHost' });
    });

    host.on('s:room:joined', (payload) => {
      roomCode = payload.roomCode;
      log(`Room created: ${roomCode}`);
      resolve(roomCode);
    });

    host.on('s:leaderboard', () => {
      // Auto-advance through leaderboard screens
      setTimeout(() => {
        host.emit('c:host:next', { roomCode });
      }, 1000);
    });

    host.on('s:round:reveal', () => {
      setTimeout(() => {
        host.emit('c:host:next', { roomCode });
      }, 2000);
    });

    host.on('s:game:over', () => {
      log('Game over — host disconnecting');
      setTimeout(() => host.disconnect(), 2000);
    });

    host.on('connect_error', reject);
    setTimeout(() => reject(new Error('Host connection timeout')), 10000);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting stress test — ${PLAYER_COUNT} players → ${SERVER_URL}`);
  log(`Auto-create room: ${AUTO_CREATE}`);
  log(`Think time: ${THINK_TIME_MS}ms`);
  log('');

  let roomCode;

  if (AUTO_CREATE) {
    try {
      roomCode = await createHostAndRoom();
      // Give players time to connect before host starts game
      log(`Waiting 3s before starting game...`);
      await new Promise((r) => setTimeout(r, 3000));

      // Start the game via a temporary host socket
      const starter = ClientIO(SERVER_URL, { transports: ['websocket'], reconnection: false });
      await new Promise((resolve) => {
        starter.on('connect', () => {
          starter.emit('c:host:start', { roomCode });
          setTimeout(() => { starter.disconnect(); resolve(); }, 500);
        });
      });

    } catch (err) {
      console.error('Failed to create host room:', err.message);
      process.exit(1);
    }
  } else {
    roomCode = process.env.ROOM_CODE;
    if (!roomCode) {
      console.error('Error: ROOM_CODE env var is required when AUTO_CREATE is not set');
      console.error('Usage: ROOM_CODE=XXXXX node tests/stress/concurrentPlayers.js');
      process.exit(1);
    }
    log(`Using existing room: ${roomCode}`);
  }

  // Spawn all players simultaneously in batches to avoid overwhelming the event loop
  const BATCH_SIZE = 20;
  const BATCH_DELAY_MS = 200;

  log(`Spawning ${PLAYER_COUNT} players in batches of ${BATCH_SIZE}...`);

  const allPromises = [];
  for (let i = 0; i < PLAYER_COUNT; i += BATCH_SIZE) {
    const batch = Array.from(
      { length: Math.min(BATCH_SIZE, PLAYER_COUNT - i) },
      (_, j) => simulatePlayer(roomCode, i + j + 1)
    );
    allPromises.push(...batch);

    if (i + BATCH_SIZE < PLAYER_COUNT) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  log(`All ${PLAYER_COUNT} players spawned — waiting for game to complete...`);

  await Promise.allSettled(allPromises);

  logMetrics();

  // Exit with error code if too many failures
  const failureRate = metrics.errors / PLAYER_COUNT;
  if (failureRate > 0.05) { // more than 5% errors = fail
    log(`FAIL: Error rate ${(failureRate * 100).toFixed(1)}% exceeds 5% threshold`);
    process.exit(1);
  } else {
    log(`PASS: Error rate ${(failureRate * 100).toFixed(1)}% is within acceptable threshold`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Stress test crashed:', err);
  process.exit(1);
});