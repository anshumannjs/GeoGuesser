'use strict';

require('dotenv').config()
const http = require('http');
const path = require('path');
const fs   = require('fs');

const express  = require('express');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const config   = require('./config');
const logger   = require('./logger');
const { registerSocketHandlers } = require('./socketHandlers');
const rooms      = require('./rooms');
const gameState  = require('./gameState');
const { readCheckpoint } = require('./persistence');

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-eval'",
          "'unsafe-inline'",
          'cdn.jsdelivr.net',
          'unpkg.com',
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'cdn.jsdelivr.net',
          'unpkg.com',
          'fonts.googleapis.com',
        ],
        fontSrc: [
          "'self'",
          'fonts.gstatic.com',
        ],
        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          '*.mapillary.com',
          'mapillary.com',
          '*.mapbox.com',
          'mapbox.com',
          '*.googleapis.com',
          '*.gstatic.com',
          '*.openstreetmap.org',
          '*.cartocdn.com',        // <-- FIXED: Wildcard at root level for CARTO
          '*.stadiamaps.com',      // <-- ADDED: Allows Stadia/Stamen maps if used
          '*.fbcdn.net',
          '*.fna.fbcdn.net',
        ],
        connectSrc: [
          "'self'",
          'graph.mapillary.com',
          'tiles.mapillary.com',
          '*.mapillary.com',
          '*.mapbox.com',
          'mapbox.com',
          '*.openstreetmap.org',
          '*.cartocdn.com',        // <-- FIXED: Matches img-src adjustments
          '*.stadiamaps.com',      // <-- ADDED: Matches img-src adjustments
          'events.mapillary.com',
          '*.fbcdn.net',
          '*.fna.fbcdn.net',
          'unpkg.com',
          'cdn.jsdelivr.net',
        ],
        workerSrc: ["'self'", 'blob:'],
        childSrc:  ["'self'", 'blob:'],
        frameSrc:  ["'none'"],
      },
    },
  })
);

app.use(express.json({ limit: '16kb' }));

// ─── Rate Limiting ────────────────────────────────────────────────────────────

const httpLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests, please slow down.' },
});

app.use(httpLimiter);

// ─── Config Injection Helper ──────────────────────────────────────────────────

/**
 * Serve an HTML file with server-side config tokens replaced.
 * Used for /host and /play so the Mapillary token never sits
 * hardcoded in committed HTML.
 *
 * @param {string}           filePath
 * @param {express.Response} res
 */
function serveWithConfig(filePath, res) {
  try {
    let html = fs.readFileSync(filePath, 'utf8');
    html = html.replace(
      /__MAPILLARY_CLIENT_TOKEN__/g,
      config.MAPILLARY_CLIENT_TOKEN
    );
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (err) {
    logger.error({ err, filePath }, 'Failed to serve HTML file');
    res.status(500).send('Internal server error');
  }
}

// ─── HTTP Routes ──────────────────────────────────────────────────────────────

// Serve /play and /host BEFORE express.static so static middleware
// never intercepts them and skips token substitution.
app.get('/play', (req, res) => {
  serveWithConfig(path.join(__dirname, '..', 'public', 'player.html'), res);
});

app.get('/host', (req, res) => {
  serveWithConfig(path.join(__dirname, '..', 'public', 'host.html'), res);
});

// Static files (css, js, photos, etc.)
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: config.NODE_ENV === 'production' ? '1h' : 0,
    etag:   true,
  })
);

app.use(
  '/admin',
  express.static(path.join(__dirname, '..', 'admin'), { maxAge: 0 })
);

// Health check — useful for Render warm-up pings and uptime monitors
app.get('/health', (req, res) => {
  const room = rooms.getRoomOrNull();
  res.json({
    status:     'ok',
    env:        config.NODE_ENV,
    uptime:     Math.floor(process.uptime()),
    time:       new Date().toISOString(),
    room: room
      ? {
          code:        room.code,
          state:       room.state,
          playerCount: room.players.size,
        }
      : null,
  });
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global Express error handler
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  logger.error({ err, path: req.path }, 'Unhandled HTTP error');
  res.status(err.statusCode ?? 500).json({
    error: err.message ?? 'Internal server error',
    code:  err.code    ?? 'INTERNAL_SERVER_ERROR',
  });
});

// ─── HTTP + Socket.io Server ──────────────────────────────────────────────────

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin:  config.CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
  transports:       ['websocket', 'polling'],
  pingTimeout:      60_000,
  pingInterval:     15_000,
  maxHttpBufferSize: 32 * 1024,
  connectionStateRecovery: {
    maxDisconnectionDuration: 60_000,
    skipMiddlewares:          false,
  },
});

registerSocketHandlers(io);

// ─── Checkpoint Restore ───────────────────────────────────────────────────────

/**
 * On startup, attempt to restore a previous game session from the checkpoint
 * file. This handles the case where the server crashed or was redeployed
 * mid-game. Players and the host will reconnect via C_REJOIN and receive
 * S_GAME_STATE_SYNC to snap to the correct screen.
 *
 * Only restores if:
 *   1. A valid, non-expired checkpoint exists
 *   2. The game was not already in GAME_OVER state
 */
function _tryRestoreCheckpoint() {
  const checkpoint = readCheckpoint();
  if (!checkpoint) return;

  if (checkpoint.state === 'GAME_OVER') {
    logger.info('Checkpoint is GAME_OVER — not restoring');
    return;
  }

  try {
    // Restore the singleton room with all players from the checkpoint
    rooms.restoreFromCheckpoint(checkpoint);

    // Restore the game session at the last completed round index
    // If state was ROUND_ACTIVE, we treat it as if that round never happened
    // (players' guesses are lost but scores from previous rounds are intact)
    const resumeIndex = checkpoint.state === 'ROUND_ACTIVE'
      ? checkpoint.roundIndex - 1   // replay the interrupted round
      : checkpoint.roundIndex;

    if (resumeIndex >= 0) {
      // Game had at least one completed round — resume from leaderboard
      gameState.resumeFromCheckpoint(resumeIndex, io, checkpoint.roundIds);
    }
    // If resumeIndex < 0 the game had not started yet — room is in LOBBY state

    logger.info(
      {
        roomCode:    checkpoint.roomCode,
        state:       checkpoint.state,
        resumeIndex,
      },
      'Game restored from checkpoint — waiting for clients to reconnect'
    );
  } catch (err) {
    logger.error({ err }, 'Failed to restore from checkpoint — starting fresh');
    rooms.destroyRoom(false);
  }
}

// ─── Process Guards ───────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  shutdown(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection — shutting down');
  shutdown(1);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

/**
 * @param {number} [code=0]
 */
function shutdown(code = 0) {
  logger.info('Shutdown signal received — draining connections...');

  server.close(() => {
    logger.info('HTTP server closed');
    io.close(() => {
      logger.info('Socket.io server closed');
      process.exit(code);
    });
  });

  setTimeout(() => {
    logger.warn('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT',  () => shutdown(0));

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, corsOrigin: config.CORS_ORIGIN },
    'GeoGuessr server listening'
  );

  // Attempt checkpoint restore after server is listening
  // so io.to(roomCode).emit() works if resumeFromCheckpoint broadcasts
  _tryRestoreCheckpoint();
});

module.exports = { app, server, io };