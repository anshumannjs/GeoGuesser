'use strict';

const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const config = require('./config');
const logger = require('./logger');
const { registerSocketHandlers } = require('./socketHandlers');

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();

// Security headers — relax CSP slightly to allow Mapillary + Pannellum assets
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
          '*.basemaps.cartocdn.com',
          '*.tile.openstreetmap.org',
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
          '*.basemaps.cartocdn.com',
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

/**
 * Applied only to HTTP endpoints (health, any future REST routes).
 * Socket.io connections are managed separately via connection limits.
 */
const httpLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

app.use(httpLimiter);

// ─── Static Files ─────────────────────────────────────────────────────────────

app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: config.NODE_ENV === 'production' ? '1h' : 0,
    etag: true,
  })
);

app.use(
  '/admin',
  express.static(path.join(__dirname, '..', 'admin'), {
    maxAge: 0, // always fresh — you'll be editing rounds close to the event
  })
);

// ─── HTTP Routes ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    env: config.NODE_ENV,
    uptime: Math.floor(process.uptime()),
    time: new Date().toISOString(),
  });
});

// Explicit routes for the two main pages (so direct URL navigation works)
app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'player.html'));
});

app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'host.html'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// 404 fallback for unmatched HTTP routes
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global Express error handler
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  logger.error({ err, path: req.path }, 'Unhandled HTTP error');
  const status = err.statusCode ?? 500;
  res.status(status).json({
    error: err.message ?? 'Internal server error',
    code: err.code ?? 'INTERNAL_SERVER_ERROR',
  });
});

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(app);

// ─── Socket.io ────────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: {
    origin: config.CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
  // Tune transport for a controlled LAN/event environment
  transports: ['websocket', 'polling'], // websocket first, polling as fallback
  pingTimeout: 20_000,
  pingInterval: 10_000,
  maxHttpBufferSize: 32 * 1024, // 32 KB max per event payload
  connectionStateRecovery: {
    // Allow clients to recover missed events after a brief disconnect
    maxDisconnectionDuration: 30_000, // 30 seconds
    skipMiddlewares: false,
  },
});

registerSocketHandlers(io);

// ─── Process-level Error Guards ───────────────────────────────────────────────

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
 * Gracefully close the server on SIGTERM / SIGINT.
 * Gives in-flight requests and socket events up to 10 s to finish.
 *
 * @param {number} [code=0] Process exit code
 */
function shutdown(code = 0) {
  logger.info('Shutdown signal received — draining connections...');

  // Stop accepting new HTTP connections
  server.close(() => {
    logger.info('HTTP server closed');

    // Close all Socket.io connections cleanly
    io.close(() => {
      logger.info('Socket.io server closed');
      logger.info(`Exiting with code ${code}`);
      process.exit(code);
    });
  });

  // Hard kill if graceful shutdown takes too long (e.g. stuck sockets)
  setTimeout(() => {
    logger.warn('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000).unref(); // .unref() so this timer doesn't prevent natural exit
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
      corsOrigin: config.CORS_ORIGIN,
    },
    'GeoGuessr server listening'
  );
});

module.exports = { app, server, io }; // exported for potential integration testing