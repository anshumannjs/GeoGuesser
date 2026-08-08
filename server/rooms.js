'use strict';

const { customAlphabet } = require('nanoid');
const logger = require('./logger');
const config = require('./config');
const {
  MAX_PLAYERS,
  ROOM_CODE_LENGTH,
  GAME_STATE,
  ROLE,
} = require('./constants');
const { RoomError, ERROR_CODE } = require('./errors');

// ─── Join Code Generator ──────────────────────────────────────────────────────

/**
 * Alphabet deliberately excludes visually ambiguous characters:
 * 0/O, 1/I/L so players reading a code off a projector don't mistype it.
 */
const generateCode = customAlphabet('23456789ABCDEFGHJKMNPQRSTUVWXYZ', ROOM_CODE_LENGTH);

// ─── In-Memory Room Registry ──────────────────────────────────────────────────

/**
 * Master map of all active rooms.
 * Key: room code (string)
 * Value: Room object (see createRoom)
 *
 * @type {Map<string, Room>}
 */
const rooms = new Map();

/**
 * Secondary index: socketId → { roomCode, playerId }
 * Used to look up which room/player a socket belongs to on disconnect,
 * without scanning all rooms.
 *
 * @type {Map<string, { roomCode: string, playerId: string }>}
 */
const socketIndex = new Map();

// ─── Types (JSDoc) ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Player
 * @property {string} id             Stable player ID (survives reconnection)
 * @property {string} nickname        Display name chosen at join
 * @property {string} role            ROLE.HOST or ROLE.PLAYER
 * @property {string|null} socketId   Current socket ID (null if disconnected)
 * @property {boolean} connected      Whether socket is currently live
 * @property {number} score           Cumulative score across all rounds
 * @property {number} joinedAt        Unix timestamp (ms)
 * @property {number|null} lastSeenAt Unix timestamp of last disconnect (null if never)
 */

/**
 * @typedef {Object} Room
 * @property {string} code             Join code
 * @property {string} hostPlayerId     Player ID of the host
 * @property {Map<string, Player>} players  Key: player ID
 * @property {string} state            Current GAME_STATE value
 * @property {number} currentRoundIndex
 * @property {Object|null} roundTimer  Active timer handle (from gameState)
 * @property {number} createdAt        Unix timestamp (ms)
 * @property {number|null} endedAt     Unix timestamp when game ended
 * @property {NodeJS.Timeout|null} cleanupTimer  TTL cleanup handle
 */

// ─── Room Lifecycle ───────────────────────────────────────────────────────────

/**
 * Create a new room and register it.
 * Called when a host client emits C_HOST_CREATE.
 *
 * @param {string} hostSocketId  Socket ID of the creating host
 * @param {string} hostNickname  Display name for the host
 * @returns {{ room: Room, host: Player }}
 */
function createRoom(hostSocketId, hostNickname) {
  // Generate a unique code (retry on the rare collision)
  let code;
  let attempts = 0;
  do {
    code = generateCode();
    attempts++;
    if (attempts > 10) {
      // Should never happen in practice but guards against infinite loop
      throw new RoomError('Failed to generate unique room code', ERROR_CODE.INTERNAL);
    }
  } while (rooms.has(code));

  /** @type {Player} */
  const host = {
    id: _generatePlayerId(),
    nickname: hostNickname.trim(),
    role: ROLE.HOST,
    socketId: hostSocketId,
    connected: true,
    score: 0,
    joinedAt: Date.now(),
    lastSeenAt: null,
  };

  /** @type {Room} */
  const room = {
    code,
    hostPlayerId: host.id,
    players: new Map([[host.id, host]]),
    state: GAME_STATE.LOBBY,
    currentRoundIndex: -1,
    roundTimer: null,
    createdAt: Date.now(),
    endedAt: null,
    cleanupTimer: null,
  };

  rooms.set(code, room);
  socketIndex.set(hostSocketId, { roomCode: code, playerId: host.id });

  logger.info({ roomCode: code, hostId: host.id, hostNickname: host.nickname }, 'Room created');

  return { room, host };
}

/**
 * Add a player to an existing room.
 * Called when a player client emits C_JOIN.
 *
 * @param {string} roomCode
 * @param {string} socketId
 * @param {string} nickname
 * @returns {{ room: Room, player: Player }}
 */
function joinRoom(roomCode, socketId, nickname) {
  const room = _getRoom(roomCode);
  const trimmedNick = nickname.trim();

  // ── Guards ────────────────────────────────────────────────────────────────

  if (room.state !== GAME_STATE.LOBBY) {
    throw new RoomError(
      'Game has already started — you cannot join mid-game',
      ERROR_CODE.ROOM_ALREADY_STARTED
    );
  }

  if (room.players.size >= MAX_PLAYERS) {
    throw new RoomError(
      `Room is full (max ${MAX_PLAYERS} players)`,
      ERROR_CODE.ROOM_FULL
    );
  }

  // Nickname uniqueness check (case-insensitive)
  const nickTaken = [...room.players.values()].some(
    (p) => p.nickname.toLowerCase() === trimmedNick.toLowerCase()
  );
  if (nickTaken) {
    throw new RoomError(
      `Nickname "${trimmedNick}" is already taken in this room`,
      ERROR_CODE.NICKNAME_TAKEN
    );
  }

  // ── Create Player ─────────────────────────────────────────────────────────

  /** @type {Player} */
  const player = {
    id: _generatePlayerId(),
    nickname: trimmedNick,
    role: ROLE.PLAYER,
    socketId,
    connected: true,
    score: 0,
    joinedAt: Date.now(),
    lastSeenAt: null,
  };

  room.players.set(player.id, player);
  socketIndex.set(socketId, { roomCode, playerId: player.id });

  logger.info(
    { roomCode, playerId: player.id, nickname: player.nickname, totalPlayers: room.players.size },
    'Player joined room'
  );

  return { room, player };
}

// ─── Reconnection ─────────────────────────────────────────────────────────────

/**
 * Reconnect a previously-disconnected player to their existing seat.
 * Matched by nickname + room code (since the client has no persistent ID storage).
 * Called during socket reconnection before falling back to a fresh join.
 *
 * @param {string} roomCode
 * @param {string} newSocketId
 * @param {string} nickname
 * @returns {{ room: Room, player: Player } | null}  null if no match found
 */
function reconnectPlayer(roomCode, newSocketId, nickname) {
  const room = rooms.get(roomCode);
  if (!room) return null;

  const trimmedNick = nickname.trim();

  // Find a disconnected player with the same nickname
  const existing = [...room.players.values()].find(
    (p) =>
      p.nickname.toLowerCase() === trimmedNick.toLowerCase() &&
      !p.connected
  );

  if (!existing) return null;

  // Remove stale socket index entry if it exists
  if (existing.socketId) {
    socketIndex.delete(existing.socketId);
  }

  // Update player with new socket
  existing.socketId = newSocketId;
  existing.connected = true;
  existing.lastSeenAt = null;

  socketIndex.set(newSocketId, { roomCode, playerId: existing.id });

  logger.info(
    { roomCode, playerId: existing.id, nickname: existing.nickname },
    'Player reconnected'
  );

  return { room, player: existing };
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

/**
 * Mark a player as disconnected when their socket drops.
 * Does NOT remove them from the room — they can reconnect within the TTL.
 *
 * @param {string} socketId
 * @returns {{ room: Room, player: Player } | null}
 */
function handleDisconnect(socketId) {
  const entry = socketIndex.get(socketId);
  if (!entry) return null;

  const { roomCode, playerId } = entry;
  const room = rooms.get(roomCode);
  if (!room) return null;

  const player = room.players.get(playerId);
  if (!player) return null;

  player.connected = false;
  player.lastSeenAt = Date.now();
  // Keep socketId so we can remove the old entry on reconnect
  socketIndex.delete(socketId);

  logger.info(
    { roomCode, playerId, nickname: player.nickname },
    'Player disconnected (seat held)'
  );

  // If every player (including host) has disconnected, schedule room cleanup
  const anyoneConnected = [...room.players.values()].some((p) => p.connected);
  if (!anyoneConnected) {
    _scheduleCleanup(room, 5 * 60 * 1000); // 5 min if completely empty
    logger.info({ roomCode }, 'All players disconnected — room cleanup scheduled (5 min)');
  }

  return { room, player };
}

// ─── Room Cleanup ─────────────────────────────────────────────────────────────

/**
 * Fully tear down a room and release all associated memory.
 * Called after game ends (via TTL) or when explicitly closed.
 *
 * @param {string} roomCode
 */
function destroyRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  // Clear any pending cleanup timer
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }

  // Remove all socket index entries for this room's players
  for (const player of room.players.values()) {
    if (player.socketId) {
      socketIndex.delete(player.socketId);
    }
  }

  rooms.delete(roomCode);

  logger.info({ roomCode, playerCount: room.players.size }, 'Room destroyed');
}

/**
 * Schedule automatic room destruction after a delay.
 * Resets any existing timer (safe to call multiple times).
 *
 * @param {Room} room
 * @param {number} [delayMs]  Defaults to config.ROOM_TTL_MS
 */
function _scheduleCleanup(room, delayMs = config.ROOM_TTL_MS) {
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
  }
  room.cleanupTimer = setTimeout(() => {
    logger.info({ roomCode: room.code }, 'Room TTL expired — destroying');
    destroyRoom(room.code);
  }, delayMs);

  // Allow process to exit naturally even if this timer is pending
  room.cleanupTimer.unref();
}

/**
 * Schedule cleanup after a game ends.
 * Gives enough time for the final leaderboard to be displayed.
 * Called by gameState when transitioning to GAME_OVER.
 *
 * @param {string} roomCode
 */
function schedulePostGameCleanup(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.endedAt = Date.now();
  _scheduleCleanup(room, config.ROOM_TTL_MS);
  logger.info(
    { roomCode, cleanupInMs: config.ROOM_TTL_MS },
    'Post-game room cleanup scheduled'
  );
}

// ─── Getters / Queries ────────────────────────────────────────────────────────

/**
 * Get a room by code. Throws if not found.
 *
 * @param {string} roomCode
 * @returns {Room}
 */
function getRoom(roomCode) {
  return _getRoom(roomCode);
}

/**
 * Look up which room + player a socket belongs to.
 *
 * @param {string} socketId
 * @returns {{ roomCode: string, playerId: string } | null}
 */
function getRoomBySocket(socketId) {
  return socketIndex.get(socketId) ?? null;
}

/**
 * Get a player from a room by player ID. Throws if not found.
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @returns {Player}
 */
function getPlayer(roomCode, playerId) {
  const room = _getRoom(roomCode);
  const player = room.players.get(playerId);
  if (!player) {
    throw new RoomError(`Player ${playerId} not found in room ${roomCode}`, ERROR_CODE.ROOM_NOT_FOUND);
  }
  return player;
}

/**
 * Return a serializable snapshot of all players in a room,
 * sorted by score descending. Safe to broadcast to clients.
 *
 * @param {string} roomCode
 * @returns {Array<{ id: string, nickname: string, score: number, connected: boolean, role: string }>}
 */
function getPlayerSnapshot(roomCode) {
  const room = _getRoom(roomCode);
  return [...room.players.values()]
    .map(({ id, nickname, score, connected, role }) => ({
      id,
      nickname,
      score,
      connected,
      role,
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Add points to a player's cumulative score.
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @param {number} points
 */
function addScore(roomCode, playerId, points) {
  const player = getPlayer(roomCode, playerId);
  player.score += points;
}

/**
 * Check whether a socket ID belongs to the host of a given room.
 *
 * @param {string} roomCode
 * @param {string} socketId
 * @returns {boolean}
 */
function isHost(roomCode, socketId) {
  const entry = socketIndex.get(socketId);
  if (!entry || entry.roomCode !== roomCode) return false;
  const room = rooms.get(roomCode);
  if (!room) return false;
  return room.players.get(entry.playerId)?.role === ROLE.HOST;
}

/**
 * Total number of active rooms (for monitoring/health endpoint).
 *
 * @returns {number}
 */
function getRoomCount() {
  return rooms.size;
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Internal getter with error throwing.
 * @param {string} roomCode
 * @returns {Room}
 */
function _getRoom(roomCode) {
  const room = rooms.get(roomCode.toUpperCase());
  if (!room) {
    throw new RoomError(
      `Room "${roomCode}" not found`,
      ERROR_CODE.ROOM_NOT_FOUND
    );
  }
  return room;
}

/**
 * Generate a short stable player ID.
 * Not cryptographically sensitive — just needs to be unique within a session.
 *
 * @returns {string}
 */
function _generatePlayerId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  createRoom,
  joinRoom,
  reconnectPlayer,
  handleDisconnect,
  destroyRoom,
  schedulePostGameCleanup,
  getRoom,
  getRoomBySocket,
  getPlayer,
  getPlayerSnapshot,
  addScore,
  isHost,
  getRoomCount,
};