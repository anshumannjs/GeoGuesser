'use strict';

const { z }    = require('zod');
const logger   = require('./logger');
const config   = require('./config');
const {
  EVENTS,
  GAME_STATE,
  ROLE,
} = require('./constants');
const {
  ValidationError,
  AuthError,
  AppError,
  ERROR_CODE,
} = require('./errors');
const rooms     = require('./rooms');
const gameState = require('./gameState');

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const nicknameSchema = z
  .string()
  .trim()
  .min(2,  'Nickname must be at least 2 characters')
  .max(20, 'Nickname must be at most 20 characters')
  .regex(/^[a-zA-Z0-9 _\-]+$/, 'Nickname may only contain letters, numbers, spaces, _ or -');

const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(5, 'Room code must be exactly 5 characters');

const worldCoordSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const pixelCoordSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

const guessCoordSchema = z.union([worldCoordSchema, pixelCoordSchema]);

// ─── Payload Schemas ──────────────────────────────────────────────────────────

const schemas = {
  [EVENTS.C_ADMIN_AUTH]: z.object({
    password: z.string().min(1),
    nickname: nicknameSchema,
  }),

  [EVENTS.C_JOIN]: z.object({
    roomCode: roomCodeSchema,
    nickname: nicknameSchema,
  }),

  [EVENTS.C_REJOIN]: z.object({
    playerId: z.string().min(1),
    nickname: nicknameSchema,
    // adminToken is optional — only host sends it
    adminToken: z.string().optional(),
  }),

  [EVENTS.C_HOST_START]: z.object({
    roomCode: roomCodeSchema,
  }),

  [EVENTS.C_HOST_NEXT]: z.object({
    roomCode: roomCodeSchema,
  }),

  [EVENTS.C_HOST_END_ROUND]: z.object({
    roomCode: roomCodeSchema,
  }),

  [EVENTS.C_GUESS_SUBMIT]: z.object({
    roomCode:   roomCodeSchema,
    roundIndex: z.number().int().min(0),
    coord:      guessCoordSchema,
  }),
};

// ─── Validation Helper ────────────────────────────────────────────────────────

/**
 * Validate a socket event payload against its registered schema.
 *
 * @template T
 * @param {string} event
 * @param {*}      payload
 * @returns {T}
 */
function _validate(event, payload) {
  const schema = schemas[event];
  if (!schema) {
    logger.warn({ event }, 'No validation schema for event — passing through');
    return payload;
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new ValidationError(
      `Invalid payload for "${event}"`,
      result.error.issues
    );
  }
  return result.data;
}

// ─── Error Emitter ────────────────────────────────────────────────────────────

/**
 * Send a structured error to a single socket.
 *
 * @param {SocketIO.Socket} socket
 * @param {Error}           err
 */
function _emitError(socket, err) {
  const isApp = err instanceof AppError;
  if (!isApp) logger.error({ err }, 'Unexpected non-AppError in handler');

  socket.emit(EVENTS.S_ERROR, {
    code:    isApp ? err.code    : 'INTERNAL_SERVER_ERROR',
    message: isApp ? err.message : 'An unexpected error occurred',
    issues:  isApp && err.issues ? err.issues : undefined,
  });
}

// ─── Handler Wrapper ──────────────────────────────────────────────────────────

/**
 * Wrap a socket event handler with validation + structured error handling.
 *
 * @param {SocketIO.Socket} socket
 * @param {string}          event
 * @param {Function}        handler  async (parsedPayload) => void
 * @returns {Function}
 */
function _wrap(socket, event, handler) {
  return async (payload) => {
    logger.debug({ event, socketId: socket.id, payload }, 'Socket event received');
    try {
      const parsed = _validate(event, payload);
      await handler(parsed);
    } catch (err) {
      logger.warn(
        { event, socketId: socket.id, code: err.code, message: err.message },
        'Socket handler error'
      );
      _emitError(socket, err);
    }
  };
}

// ─── Auth Helpers ─────────────────────────────────────────────────────────────

/**
 * Assert socket belongs to the host of the singleton room.
 *
 * @param {string} socketId
 */
function _assertHost(socketId) {
  if (!rooms.isHost(socketId)) {
    throw new AuthError('Only the host can perform this action');
  }
}

// ─── Connection Rate Limiting ─────────────────────────────────────────────────

/** @type {Map<string, number[]>} */
const _connectionTimestamps = new Map();
const CONNECTION_WINDOW_MS       = 60_000;
// const MAX_CONNECTIONS_PER_WINDOW = 15; // increased slightly for event wifi NAT
const MAX_CONNECTIONS_PER_WINDOW = 500; // many players share one campus NAT IP; reconnects also count

/**
 * @param {string} ip
 * @returns {boolean} true = rate limited
 */
function _isRateLimited(ip) {
  if (config.NODE_ENV === 'test') return false;

  const now  = Date.now();
  const prev = (_connectionTimestamps.get(ip) ?? []).filter(
    (t) => now - t < CONNECTION_WINDOW_MS
  );
  // if (prev.length >= MAX_CONNECTIONS_PER_WINDOW) return true;
  // if (prev.length >= MAX_CONNECTIONS_PER_WINDOW) {
  //   _connectionTimestamps.set(ip, prev);
  //  return true;
  // }
  prev.push(now);
  _connectionTimestamps.set(ip, prev);
  return false;
}

// ─── State Sync Helper ────────────────────────────────────────────────────────

/**
 * Send S_GAME_STATE_SYNC to a single socket so a reconnecting client
 * can snap to the current game state without waiting for the next broadcast.
 *
 * @param {SocketIO.Socket} socket
 */
function _sendStateSync(socket) {
  const sync = gameState.buildStateSync();
  if (!sync) return;
  socket.emit(EVENTS.S_GAME_STATE_SYNC, sync);
}

// ─── Main Registration ────────────────────────────────────────────────────────

/**
 * Register all socket event handlers.
 * Called once from server/index.js.
 *
 * @param {SocketIO.Server} io
 */
function registerSocketHandlers(io) {
  gameState.initialise();

  io.on('connection', (socket) => {
    const ip = socket.handshake.headers['x-forwarded-for']
      ?? socket.handshake.address
      ?? 'unknown';

    // ── Rate limit ───────────────────────────────────────────────────────

    if (_isRateLimited(ip)) {
      logger.warn({ ip, socketId: socket.id }, 'Rate limited — disconnecting');
      socket.emit(EVENTS.S_ERROR, {
        code:    'RATE_LIMITED',
        message: 'Too many connections. Please wait a moment.',
      });
      socket.disconnect(true);
      return;
    }

    logger.info({ socketId: socket.id, ip }, 'Socket connected');

    // ────────────────────────────────────────────────────────────────────
    // C_ADMIN_AUTH
    // Host submits admin password to get/create the singleton room.
    // On success the host gets back the room code + a stable adminToken
    // that is stored in sessionStorage for future reconnections.
    // ────────────────────────────────────────────────────────────────────

    socket.on(
      EVENTS.C_ADMIN_AUTH,
      _wrap(socket, EVENTS.C_ADMIN_AUTH, ({ password, nickname }) => {

        // Wrong password
        if (password !== config.ADMIN_PASSWORD) {
          logger.warn({ socketId: socket.id }, 'Admin auth failed — wrong password');
          socket.emit(EVENTS.S_ADMIN_AUTH_FAIL, {
            message: 'Incorrect password.',
          });
          return;
        }

        let room;
        let host;
        let adminToken;

        if (rooms.roomExists()) {
          // Room already exists — this is a fresh host tab that passed auth
          // but doesn't have a saved session yet (e.g. opened a second browser)
          // We do not allow a second host — tell them to use the existing session
          logger.warn({ socketId: socket.id }, 'Room already exists — rejecting second host');
          socket.emit(EVENTS.S_ADMIN_AUTH_FAIL, {
            message: 'A room is already active. If you are the host, use your saved session to rejoin.',
          });
          return;
        }

        // Create the singleton room
        const result = rooms.createRoom(socket.id, nickname);
        room        = result.room;
        host        = result.host;
        adminToken  = result.adminToken;

        socket.join(room.code);

        socket.emit(EVENTS.S_ADMIN_AUTH_OK, {
          roomCode:    room.code,
          playerId:    host.id,
          adminToken,              // stored in sessionStorage by hostApp.js
          players:     rooms.getPlayerSnapshot(),
        });

        logger.info({ roomCode: room.code, hostNickname: nickname }, 'Room created via admin auth');
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // C_REJOIN
    // Sent by any client (host or player) on page refresh/reconnect.
    // Uses playerId from sessionStorage — no form re-entry needed.
    // Host additionally sends adminToken for identity verification.
    // ────────────────────────────────────────────────────────────────────

    socket.on(
      EVENTS.C_REJOIN,
      _wrap(socket, EVENTS.C_REJOIN, ({ playerId, nickname, adminToken }) => {

        // ── Host rejoin ──────────────────────────────────────────────────
        if (adminToken) {
          const { room, host } = rooms.reconnectHost(socket.id, adminToken);
          socket.join(room.code);

          socket.emit(EVENTS.S_ROOM_JOINED, {
            roomCode:    room.code,
            playerId:    host.id,
            role:        ROLE.HOST,
            players:     rooms.getPlayerSnapshot(),
            reconnected: true,
            gameState:   room.state,
          });

          // Send full state so host display can snap to current screen
          _sendStateSync(socket);

          // Notify players host is back
          socket.to(room.code).emit(EVENTS.S_ROOM_PLAYERS, {
            players: rooms.getPlayerSnapshot(),
          });

          logger.info({ roomCode: room.code }, 'Host rejoined via C_REJOIN');
          return;
        }

        // ── Player rejoin ────────────────────────────────────────────────
        const result = rooms.reconnectPlayer(socket.id, playerId, nickname);

        if (!result) {
          // Could not match — fall back: tell client to show join form
          socket.emit(EVENTS.S_ERROR, {
            code:    ERROR_CODE.PLAYER_NOT_FOUND,
            message: 'Session not found. Please join with your room code and nickname.',
          });
          return;
        }

        const { room, player } = result;
        socket.join(room.code);

        socket.emit(EVENTS.S_ROOM_JOINED, {
          roomCode:    room.code,
          playerId:    player.id,
          role:        ROLE.PLAYER,
          players:     rooms.getPlayerSnapshot(),
          reconnected: true,
          gameState:   room.state,
        });

        // Send full state so player can snap to current screen
        _sendStateSync(socket);

        // Notify others this player is back online
        socket.to(room.code).emit(EVENTS.S_ROOM_PLAYERS, {
          players: rooms.getPlayerSnapshot(),
        });

        logger.info(
          { roomCode: room.code, playerId: player.id, nickname: player.nickname },
          'Player rejoined via C_REJOIN'
        );
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // C_JOIN
    // Fresh player join — only valid while game is in LOBBY state.
    // Once game starts, players must use C_REJOIN with their saved playerId.
    // ────────────────────────────────────────────────────────────────────

    socket.on(
      EVENTS.C_JOIN,
      _wrap(socket, EVENTS.C_JOIN, ({ roomCode, nickname }) => {
        const { room, player } = rooms.joinRoom(socket.id, nickname);

        socket.join(room.code);

        socket.emit(EVENTS.S_ROOM_JOINED, {
          roomCode:    room.code,
          playerId:    player.id,
          role:        ROLE.PLAYER,
          players:     rooms.getPlayerSnapshot(),
          reconnected: false,
          gameState:   GAME_STATE.LOBBY,
        });

        socket.to(room.code).emit(EVENTS.S_ROOM_PLAYERS, {
          players: rooms.getPlayerSnapshot(),
        });

        logger.info(
          { roomCode: room.code, playerId: player.id, nickname, totalPlayers: room.players.size },
          'Player joined'
        );
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // C_HOST_START — host starts the game
    // ────────────────────────────────────────────────────────────────────

    socket.on(
      EVENTS.C_HOST_START,
      _wrap(socket, EVENTS.C_HOST_START, ({ roomCode }) => {
        _assertHost(socket.id);
        gameState.startGame(io);
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // C_HOST_NEXT — advance past reveal or leaderboard
    // ────────────────────────────────────────────────────────────────────

    socket.on(
      EVENTS.C_HOST_NEXT,
      _wrap(socket, EVENTS.C_HOST_NEXT, ({ roomCode }) => {
        _assertHost(socket.id);
        gameState.hostAdvance(io);
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // C_HOST_END_ROUND — force-end an active round early
    // This is the FIX — separate event from C_HOST_NEXT so there is
    // no ambiguity about which game state we're operating on.
    // ────────────────────────────────────────────────────────────────────

    socket.on(
      EVENTS.C_HOST_END_ROUND,
      _wrap(socket, EVENTS.C_HOST_END_ROUND, ({ roomCode }) => {
        _assertHost(socket.id);
        gameState.forceEndRound(io);
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // C_GUESS_SUBMIT — player submits a guess
    // ────────────────────────────────────────────────────────────────────

    socket.on(
      EVENTS.C_GUESS_SUBMIT,
      _wrap(socket, EVENTS.C_GUESS_SUBMIT, ({ roomCode, roundIndex, coord }) => {
        const entry = rooms.getRoomBySocket(socket.id);

        if (!entry) {
          throw new AuthError('You are not a member of this room');
        }

        const player = rooms.getPlayer(entry.playerId);

        if (player.role === ROLE.HOST) {
          throw new AuthError('The host cannot submit guesses');
        }

        const room = rooms.getRoom();
        if (room.state !== GAME_STATE.ROUND_ACTIVE) {
          throw new AuthError('No active round to guess for');
        }

        // Stale-round guard — client roundIndex must match server
        const session = gameState.getSession();
        if (session && session.currentIndex !== roundIndex) {
          throw new AuthError('Guess is for a stale round — ignoring');
        }

        const result = gameState.submitGuess(entry.playerId, coord, io);

        socket.emit(EVENTS.S_GUESS_ACK, {
          accepted:     result.accepted,
          guessCount:   result.guessCount,
          totalPlayers: result.totalPlayers,
          roundIndex,
        });
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // disconnect
    // ────────────────────────────────────────────────────────────────────

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'Socket disconnected');

      const result = rooms.handleDisconnect(socket.id);
      if (!result) return;

      const { room, player } = result;

      io.to(room.code).emit(EVENTS.S_ROOM_PLAYERS, {
        players: rooms.getPlayerSnapshot(),
      });

      if (player.role === ROLE.HOST) {
        io.to(room.code).emit(EVENTS.S_ERROR, {
          code:    'HOST_DISCONNECTED',
          message: 'Host disconnected — game will resume when they return.',
        });
        logger.warn({ roomCode: room.code }, 'Host disconnected mid-game');
      }
    });

    // ────────────────────────────────────────────────────────────────────
    // Socket-level error
    // ────────────────────────────────────────────────────────────────────

    socket.on('error', (err) => {
      logger.error({ socketId: socket.id, err }, 'Socket-level error');
    });
  });

  io.engine.on('connection_error', (err) => {
    logger.error({ err }, 'Socket.io engine connection error');
  });

  logger.info('Socket handlers registered');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { registerSocketHandlers };