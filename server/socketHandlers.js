'use strict';

const { z }    = require('zod');
const logger   = require('./logger');
const config   = require('./config');
const {
  EVENTS,
  GAME_STATE,
  ROLE,
  MAX_PLAYERS,
} = require('./constants');
const { ValidationError, AuthError, AppError } = require('./errors');
const rooms     = require('./rooms');
const gameState = require('./gameState');

// ─── Zod Schemas (input validation) ──────────────────────────────────────────

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
  [EVENTS.C_HOST_CREATE]: z.object({
    nickname: nicknameSchema,
  }),

  [EVENTS.C_JOIN]: z.object({
    roomCode: roomCodeSchema,
    nickname: nicknameSchema,
  }),

  [EVENTS.C_GUESS_SUBMIT]: z.object({
    roomCode:  roomCodeSchema,
    roundIndex: z.number().int().min(0),
    coord:     guessCoordSchema,
  }),

  [EVENTS.C_HOST_START]: z.object({
    roomCode: roomCodeSchema,
  }),

  [EVENTS.C_HOST_NEXT]: z.object({
    roomCode: roomCodeSchema,
  }),
};

// ─── Validation Helper ────────────────────────────────────────────────────────

/**
 * Validate a socket event payload against its schema.
 * Throws ValidationError with structured issues on failure.
 *
 * @template T
 * @param {string} event   Event name (key into schemas map)
 * @param {*}      payload Raw payload from client
 * @returns {T}            Parsed + coerced payload
 */
function _validate(event, payload) {
  const schema = schemas[event];
  if (!schema) {
    // No schema registered — pass through (should not happen in practice)
    logger.warn({ event }, 'No validation schema found for event');
    return payload;
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new ValidationError(
      `Invalid payload for event "${event}"`,
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
 * @param {AppError|Error}  err
 */
function _emitError(socket, err) {
  const isAppError = err instanceof AppError;

  if (!isAppError) {
    logger.error({ err }, 'Unexpected non-AppError in socket handler');
  }

  socket.emit(EVENTS.S_ERROR, {
    code:    isAppError ? err.code    : 'INTERNAL_SERVER_ERROR',
    message: isAppError ? err.message : 'An unexpected error occurred',
    issues:  isAppError && err.issues ? err.issues : undefined,
  });
}

// ─── Handler Wrapper ──────────────────────────────────────────────────────────

/**
 * Wrap a socket event handler with:
 *   - Payload validation
 *   - Structured error handling
 *   - Per-event logging
 *
 * @param {SocketIO.Socket} socket
 * @param {string}          event
 * @param {Function}        handler  async (parsedPayload) => void
 * @returns {Function}               The wrapped listener to pass to socket.on()
 */
function _wrap(socket, event, handler) {
  return async (payload) => {
    const socketId = socket.id;
    logger.debug({ event, socketId, payload }, 'Socket event received');

    try {
      const parsed = _validate(event, payload);
      await handler(parsed);
    } catch (err) {
      logger.warn(
        { event, socketId, err: { code: err.code, message: err.message } },
        'Socket handler error'
      );
      _emitError(socket, err);
    }
  };
}

// ─── Auth Helper ─────────────────────────────────────────────────────────────

/**
 * Assert that the socket is the host of the given room.
 * Throws AuthError if not.
 *
 * @param {string} roomCode
 * @param {string} socketId
 */
function _assertHost(roomCode, socketId) {
  if (!rooms.isHost(roomCode, socketId)) {
    throw new AuthError('Only the host can perform this action');
  }
}

// ─── Connection Rate Limiting ─────────────────────────────────────────────────

/**
 * Simple in-memory rate limiter for socket connections.
 * Tracks connection timestamps per IP.
 *
 * @type {Map<string, number[]>}
 */
const _connectionTimestamps = new Map();
const CONNECTION_WINDOW_MS  = 60_000; // 1 minute
const MAX_CONNECTIONS_PER_WINDOW = 10;

/**
 * Check whether an IP has exceeded the connection rate limit.
 *
 * @param {string} ip
 * @returns {boolean}  true if rate limited (should reject)
 */
function _isConnectionRateLimited(ip) {
  const now  = Date.now();
  const prev = (_connectionTimestamps.get(ip) ?? []).filter(
    (t) => now - t < CONNECTION_WINDOW_MS
  );

  if (prev.length >= MAX_CONNECTIONS_PER_WINDOW) return true;

  prev.push(now);
  _connectionTimestamps.set(ip, prev);
  return false;
}

// ─── Main Registration ────────────────────────────────────────────────────────

/**
 * Register all socket event handlers on the Socket.io server.
 * Called once from index.js after the io instance is created.
 *
 * @param {SocketIO.Server} io
 */
function registerSocketHandlers(io) {
  // Initialise game state (loads rounds from disk)
  gameState.initialise();

  io.on('connection', (socket) => {
    const ip = socket.handshake.headers['x-forwarded-for']
      ?? socket.handshake.address
      ?? 'unknown';

    // ── Connection rate limit ────────────────────────────────────────────

    if (_isConnectionRateLimited(ip)) {
      logger.warn({ ip, socketId: socket.id }, 'Connection rate limited — disconnecting');
      socket.emit(EVENTS.S_ERROR, {
        code:    'RATE_LIMITED',
        message: 'Too many connections. Please wait a moment and try again.',
      });
      socket.disconnect(true);
      return;
    }

    logger.info({ socketId: socket.id, ip }, 'Socket connected');

    // ────────────────────────────────────────────────────────────────────
    // C_HOST_CREATE — Host creates a new room
    // ────────────────────────────────────────────────────────────────────

    socket.on(
      EVENTS.C_HOST_CREATE,
      _wrap(socket, EVENTS.C_HOST_CREATE, ({ nickname }) => {
        const { room, host } = rooms.createRoom(socket.id, nickname);

        // Host joins their own Socket.io room
        socket.join(room.code);

        socket.emit(EVENTS.S_ROOM_JOINED, {
          roomCode:   room.code,
          playerId:   host.id,
          role:       ROLE.HOST,
          players:    rooms.getPlayerSnapshot(room.code),
          totalRounds: null, // not known until game starts
        });

        logger.info(
          { roomCode: room.code, hostNickname: nickname },
          'Host created room'
        );
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // C_JOIN — Player joins an existing room
    // ────────────────────────────────────────────────────────────────────

    socket.on(
      EVENTS.C_JOIN,
      _wrap(socket, EVENTS.C_JOIN, ({ roomCode, nickname }) => {

        // ── Attempt reconnection first ───────────────────────────────

        const reconnected = rooms.reconnectPlayer(roomCode, socket.id, nickname);

        if (reconnected) {
          const { room, player } = reconnected;
          socket.join(roomCode);

          // Send them back their current game state so they can re-render
          const currentRoom = rooms.getRoom(roomCode);
          socket.emit(EVENTS.S_ROOM_JOINED, {
            roomCode,
            playerId:    player.id,
            role:        player.role,
            players:     rooms.getPlayerSnapshot(roomCode),
            reconnected: true,
            gameState:   currentRoom.state,
          });

          // Notify others that this player is back
          socket.to(roomCode).emit(EVENTS.S_ROOM_PLAYERS, {
            players: rooms.getPlayerSnapshot(roomCode),
          });

          logger.info(
            { roomCode, playerId: player.id, nickname },
            'Player reconnected via C_JOIN'
          );
          return;
        }

        // ── Fresh join ───────────────────────────────────────────────

        const { room, player } = rooms.joinRoom(roomCode, socket.id, nickname);
        socket.join(roomCode);

        // Confirm join to the new player
        socket.emit(EVENTS.S_ROOM_JOINED, {
          roomCode,
          playerId:    player.id,
          role:        ROLE.PLAYER,
          players:     rooms.getPlayerSnapshot(roomCode),
          reconnected: false,
          gameState:   GAME_STATE.LOBBY,
        });

        // Broadcast updated player list to everyone else in the room
        socket.to(roomCode).emit(EVENTS.S_ROOM_PLAYERS, {
          players: rooms.getPlayerSnapshot(roomCode),
        });

        logger.info(
          { roomCode, playerId: player.id, nickname, totalPlayers: room.players.size },
          'Player joined room'
        );
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // C_HOST_START — Host starts the game
    // ────────────────────────────────────────────────────────────────────

    socket.on(
      EVENTS.C_HOST_START,
      _wrap(socket, EVENTS.C_HOST_START, ({ roomCode }) => {
        _assertHost(roomCode, socket.id);
        gameState.startGame(roomCode, io);
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // C_HOST_NEXT — Host manually advances past reveal / leaderboard
    // ────────────────────────────────────────────────────────────────────

    socket.on(
      EVENTS.C_HOST_NEXT,
      _wrap(socket, EVENTS.C_HOST_NEXT, ({ roomCode }) => {
        _assertHost(roomCode, socket.id);
        gameState.hostAdvance(roomCode, io);
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // C_GUESS_SUBMIT — Player submits a guess for the current round
    // ────────────────────────────────────────────────────────────────────

    socket.on(
      EVENTS.C_GUESS_SUBMIT,
      _wrap(socket, EVENTS.C_GUESS_SUBMIT, ({ roomCode, roundIndex, coord }) => {
        const entry = rooms.getRoomBySocket(socket.id);

        // Ensure this socket actually belongs to the room they claim
        if (!entry || entry.roomCode !== roomCode) {
          throw new AuthError('You are not a member of this room');
        }

        // Reject host guesses — host is spectator only
        const player = rooms.getPlayer(roomCode, entry.playerId);
        if (player.role === ROLE.HOST) {
          throw new AuthError('The host cannot submit guesses');
        }

        // Stale-round guard: client's roundIndex must match server's current round
        // Prevents a race where a guess arrives just after the round ended
        const room = rooms.getRoom(roomCode);
        if (room.state !== GAME_STATE.ROUND_ACTIVE) {
          throw new AuthError('No active round to guess for');
        }

        const result = gameState.submitGuess(
          roomCode,
          entry.playerId,
          coord,
          io
        );

        // Acknowledge to the individual player
        socket.emit(EVENTS.S_GUESS_ACK, {
          accepted:     result.accepted,
          guessCount:   result.guessCount,
          totalPlayers: result.totalPlayers,
          roundIndex,
        });
      })
    );

    // ────────────────────────────────────────────────────────────────────
    // disconnect — Clean up on socket drop
    // ────────────────────────────────────────────────────────────────────

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'Socket disconnected');

      const result = rooms.handleDisconnect(socket.id);
      if (!result) return;

      const { room, player } = result;

      // Notify remaining players that this player went offline
      // (they stay in the room and can reconnect)
      io.to(room.code).emit(EVENTS.S_ROOM_PLAYERS, {
        players: rooms.getPlayerSnapshot(room.code),
      });

      // If the host disconnects mid-game, warn the room
      if (player.role === ROLE.HOST) {
        io.to(room.code).emit(EVENTS.S_ERROR, {
          code:    'HOST_DISCONNECTED',
          message: 'The host has disconnected. Game will resume if they reconnect.',
        });
        logger.warn({ roomCode: room.code }, 'Host disconnected mid-game');
      }
    });

    // ────────────────────────────────────────────────────────────────────
    // connect_error — Log Socket.io internal errors
    // ────────────────────────────────────────────────────────────────────

    socket.on('error', (err) => {
      logger.error({ socketId: socket.id, err }, 'Socket-level error');
    });
  });

  // ── Global server-level error logging ─────────────────────────────────────

  io.engine.on('connection_error', (err) => {
    logger.error({ err }, 'Socket.io engine connection error');
  });

  logger.info('Socket handlers registered');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { registerSocketHandlers };