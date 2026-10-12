'use strict';

const { customAlphabet } = require('nanoid');
const logger  = require('./logger');
const config  = require('./config');
const {
  MAX_PLAYERS,
  ROOM_CODE_LENGTH,
  GAME_STATE,
  ROLE,
} = require('./constants');
const { RoomError, AuthError, ERROR_CODE } = require('./errors');

// ─── Join Code Generator ──────────────────────────────────────────────────────

/**
 * Excludes visually ambiguous characters (0/O, 1/I/L)
 * so players reading a code off a projector don't mistype it.
 */
const generateCode = customAlphabet(
  '23456789ABCDEFGHJKMNPQRSTUVWXYZ',
  ROOM_CODE_LENGTH
);

// ─── Singleton Room ───────────────────────────────────────────────────────────

/**
 * There is exactly one room per server instance.
 * All state lives here; no Map of rooms needed.
 *
 * @type {Room|null}
 */
let _room = null;

/**
 * The admin token is a server-side secret generated at room creation.
 * It is stored here (never sent to clients in plain text) and is used
 * to verify that a reconnecting host is the original host.
 *
 * @type {string|null}
 */
let _adminToken = null;

/**
 * Secondary index: socketId → { playerId }
 * O(1) lookup from socket to player on any event/disconnect.
 *
 * @type {Map<string, { playerId: string }>}
 */
const socketIndex = new Map();

// ─── Types (JSDoc) ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Player
 * @property {string}      id
 * @property {string}      nickname
 * @property {string}      role         ROLE.HOST | ROLE.PLAYER
 * @property {string|null} socketId     Current socket ID (null if disconnected)
 * @property {boolean}     connected
 * @property {number}      score
 * @property {number}      joinedAt
 * @property {number|null} lastSeenAt
 */

/**
 * @typedef {Object} Room
 * @property {string}                  code
 * @property {string}                  hostPlayerId
 * @property {Map<string, Player>}     players       Key: player ID
 * @property {string}                  state         GAME_STATE value
 * @property {number}                  createdAt
 * @property {number|null}             endedAt
 * @property {NodeJS.Timeout|null}     cleanupTimer
 */

// ─── Admin Token ──────────────────────────────────────────────────────────────

/**
 * Generate a new admin token.
 * This is what gets stored in sessionStorage on the host device
 * and is sent back on reconnect to prove identity.
 *
 * @returns {string}
 */
function generateAdminToken() {
  // 32 random alphanumeric chars — enough entropy for a college event
  return customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', 32)();
}

/**
 * Validate an admin token against the stored one.
 *
 * @param {string} token
 * @returns {boolean}
 */
function validateAdminToken(token) {
  if (!_adminToken || !token) return false;
  return _adminToken === token;
}

/**
 * Get the current admin token (for checkpoint persistence).
 *
 * @returns {string|null}
 */
function getAdminToken() {
  return _adminToken;
}

// ─── Room Lifecycle ───────────────────────────────────────────────────────────

/**
 * Create the singleton room.
 * Throws ROOM_ALREADY_EXISTS if a room is already active.
 * Called when the host submits the correct admin password.
 *
 * @param {string} hostSocketId
 * @param {string} hostNickname
 * @returns {{ room: Room, host: Player, adminToken: string }}
 */
function createRoom(hostSocketId, hostNickname) {
  if (_room !== null) {
    throw new RoomError(
      'A room is already active. Only one room can exist at a time.',
      ERROR_CODE.ROOM_ALREADY_EXISTS
    );
  }

  const code  = generateCode();
  const token = generateAdminToken();

  /** @type {Player} */
  const host = {
    id:          _generatePlayerId(),
    nickname:    hostNickname.trim(),
    role:        ROLE.HOST,
    socketId:    hostSocketId,
    connected:   true,
    score:       0,
    joinedAt:    Date.now(),
    lastSeenAt:  null,
  };

  /** @type {Room} */
  _room = {
    code,
    hostPlayerId:  host.id,
    players:       new Map([[host.id, host]]),
    state:         GAME_STATE.LOBBY,
    createdAt:     Date.now(),
    endedAt:       null,
    cleanupTimer:  null,
  };

  _adminToken = token;
  socketIndex.set(hostSocketId, { playerId: host.id });

  logger.info(
    { roomCode: code, hostId: host.id, hostNickname: host.nickname },
    'Singleton room created'
  );

  return { room: _room, host, adminToken: token };
}

/**
 * Restore the singleton room from a checkpoint snapshot.
 * Called on server startup when a valid checkpoint is found.
 *
 * @param {import('./persistence').Checkpoint} checkpoint
 * @returns {Room}
 */
function restoreFromCheckpoint(checkpoint) {
  const players = new Map();

  for (const p of checkpoint.players) {
    players.set(p.id, {
      id:          p.id,
      nickname:    p.nickname,
      role:        p.role,
      socketId:    null,      // all sockets are dead after restart
      connected:   false,
      score:       p.score,
      joinedAt:    Date.now(),
      lastSeenAt:  Date.now(),
    });
  }

  _room = {
    code:          checkpoint.roomCode,
    hostPlayerId:  checkpoint.hostPlayerId,
    players,
    state:         checkpoint.state,
    createdAt:     Date.now(),
    endedAt:       null,
    cleanupTimer:  null,
  };

  _adminToken = checkpoint.adminToken;

  logger.info(
    {
      roomCode:    checkpoint.roomCode,
      state:       checkpoint.state,
      roundIndex:  checkpoint.roundIndex,
      playerCount: players.size,
    },
    'Room restored from checkpoint'
  );

  return _room;
}

// ─── Host Reconnect ───────────────────────────────────────────────────────────

/**
 * Reconnect the host using their adminToken stored in sessionStorage.
 * Token match = they are the original host. No password re-entry needed.
 *
 * @param {string} newSocketId
 * @param {string} adminToken
 * @returns {{ room: Room, host: Player }}
 */
function reconnectHost(newSocketId, adminToken) {
  if (!_room) {
    throw new RoomError('No active room to reconnect to', ERROR_CODE.ROOM_NOT_FOUND);
  }

  if (!validateAdminToken(adminToken)) {
    throw new AuthError('Invalid admin token — cannot reconnect as host');
  }

  const host = _room.players.get(_room.hostPlayerId);
  if (!host) {
    throw new RoomError('Host player record not found', ERROR_CODE.ROOM_NOT_FOUND);
  }

  // Remove stale socket index entry
  if (host.socketId) {
    socketIndex.delete(host.socketId);
  }

  host.socketId    = newSocketId;
  host.connected   = true;
  host.lastSeenAt  = null;

  socketIndex.set(newSocketId, { playerId: host.id });

  logger.info({ roomCode: _room.code, hostId: host.id }, 'Host reconnected via adminToken');

  return { room: _room, host };
}

// ─── Player Join / Reconnect ──────────────────────────────────────────────────

/**
 * Add a new player to the singleton room.
 *
 * @param {string} socketId
 * @param {string} nickname
 * @returns {{ room: Room, player: Player }}
 */
function joinRoom(socketId, nickname) {
  if (!_room) {
    throw new RoomError('No active room — host has not created one yet', ERROR_CODE.ROOM_NOT_FOUND);
  }

  const trimmedNick = nickname.trim();

  if (_room.state !== GAME_STATE.LOBBY) {
    throw new RoomError(
      'Game has already started — you cannot join mid-game',
      ERROR_CODE.ROOM_ALREADY_STARTED
    );
  }

  if (_room.players.size >= MAX_PLAYERS) {
    throw new RoomError(`Room is full (max ${MAX_PLAYERS} players)`, ERROR_CODE.ROOM_FULL);
  }

  // Case-insensitive nickname uniqueness
  const nickTaken = [..._room.players.values()].some(
    (p) => p.nickname.toLowerCase() === trimmedNick.toLowerCase()
  );
  if (nickTaken) {
    throw new RoomError(
      `Nickname "${trimmedNick}" is already taken`,
      ERROR_CODE.NICKNAME_TAKEN
    );
  }

  /** @type {Player} */
  const player = {
    id:          _generatePlayerId(),
    nickname:    trimmedNick,
    role:        ROLE.PLAYER,
    socketId,
    connected:   true,
    score:       0,
    joinedAt:    Date.now(),
    lastSeenAt:  null,
  };

  _room.players.set(player.id, player);
  socketIndex.set(socketId, { playerId: player.id });

  logger.info(
    {
      roomCode:     _room.code,
      playerId:     player.id,
      nickname:     player.nickname,
      totalPlayers: _room.players.size,
    },
    'Player joined'
  );

  return { room: _room, player };
}

/**
 * Reconnect a previously-disconnected player by their stable playerId.
 * playerId comes from the client's sessionStorage — set there at first join.
 *
 * This is the key fix over the old nickname-based reconnect:
 *   - Works mid-game (no ROOM_ALREADY_STARTED check)
 *   - Does not require re-typing nickname
 *   - Immune to nickname collisions
 *
 * @param {string} newSocketId
 * @param {string} playerId
 * @param {string} nickname  Used only for verification (must match stored nickname)
 * @returns {{ room: Room, player: Player } | null}  null if no valid match
 */
function reconnectPlayer(newSocketId, playerId, nickname) {
  if (!_room) return null;

  const existing = _room.players.get(playerId);
  if (!existing) return null;

  // Extra safety: verify nickname matches what we have on record
  // Prevents someone guessing a playerId and hijacking another player's seat
  if (existing.nickname.toLowerCase() !== nickname.trim().toLowerCase()) {
    logger.warn(
      { playerId, expected: existing.nickname, got: nickname },
      'Reconnect rejected — nickname mismatch'
    );
    return null;
  }

  // Do not reconnect the host via this path — host uses reconnectHost()
  if (existing.role === ROLE.HOST) return null;

  // Remove stale socket index
  if (existing.socketId) {
    socketIndex.delete(existing.socketId);
  }

  existing.socketId   = newSocketId;
  existing.connected  = true;
  existing.lastSeenAt = null;

  socketIndex.set(newSocketId, { playerId: existing.id });

  logger.info(
    { roomCode: _room.code, playerId: existing.id, nickname: existing.nickname },
    'Player reconnected via playerId'
  );

  return { room: _room, player: existing };
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

/**
 * Mark a player as disconnected.
 * Seat is held — they can rejoin via reconnectPlayer() or reconnectHost().
 *
 * @param {string} socketId
 * @returns {{ room: Room, player: Player } | null}
 */
function handleDisconnect(socketId) {
  const entry = socketIndex.get(socketId);
  if (!entry) return null;
  if (!_room)  return null;

  const player = _room.players.get(entry.playerId);
  if (!player) return null;

  player.connected   = false;
  player.lastSeenAt  = Date.now();
  socketIndex.delete(socketId);

  logger.info(
    { roomCode: _room.code, playerId: player.id, nickname: player.nickname },
    'Player disconnected (seat held)'
  );

  // Schedule cleanup only if EVERY player including host is gone
  const anyoneConnected = [..._room.players.values()].some((p) => p.connected);
  if (!anyoneConnected) {
    _scheduleCleanup(5 * 60 * 1000); // 5 min grace period
    logger.info({ roomCode: _room.code }, 'All players gone — cleanup scheduled (5 min)');
  }

  return { room: _room, player };
}

// ─── Room Cleanup ─────────────────────────────────────────────────────────────

/**
 * Destroy the singleton room and release all memory.
 *
 * @param {boolean} [deleteCheckpointFile=false]
 */
function destroyRoom(deleteCheckpointFile = false) {
  if (!_room) return;

  if (_room.cleanupTimer) {
    clearTimeout(_room.cleanupTimer);
  }

  socketIndex.clear();

  const code = _room.code;
  _room       = null;
  _adminToken = null;

  if (deleteCheckpointFile) {
    try {
      const { deleteCheckpoint } = require('./persistence');
      deleteCheckpoint();
    } catch (_) {}
  }

  logger.info({ roomCode: code }, 'Singleton room destroyed');
}

/**
 * Schedule automatic room destruction.
 *
 * @param {number} [delayMs]
 */
function _scheduleCleanup(delayMs = config.ROOM_TTL_MS) {
  if (!_room) return;

  if (_room.cleanupTimer) {
    clearTimeout(_room.cleanupTimer);
  }

  _room.cleanupTimer = setTimeout(() => {
    logger.info({ roomCode: _room?.code }, 'Room TTL expired — destroying');
    destroyRoom(true);
  }, delayMs);

  _room.cleanupTimer.unref();
}

/**
 * Schedule post-game cleanup.
 * Called by gameState when game ends.
 */
function schedulePostGameCleanup() {
  if (!_room) return;
  _room.endedAt = Date.now();
  _scheduleCleanup(config.ROOM_TTL_MS);
  logger.info({ roomCode: _room.code }, 'Post-game cleanup scheduled');
}

// ─── Getters ──────────────────────────────────────────────────────────────────

/**
 * Get the singleton room. Throws if no room exists.
 *
 * @returns {Room}
 */
function getRoom() {
  if (!_room) {
    throw new RoomError('No active room', ERROR_CODE.ROOM_NOT_FOUND);
  }
  return _room;
}

/**
 * Get the singleton room without throwing.
 *
 * @returns {Room|null}
 */
function getRoomOrNull() {
  return _room;
}

/**
 * Get the room code of the active singleton room.
 *
 * @returns {string|null}
 */
function getRoomCode() {
  return _room?.code ?? null;
}

/**
 * Look up which player a socket belongs to.
 *
 * @param {string} socketId
 * @returns {{ playerId: string } | null}
 */
function getRoomBySocket(socketId) {
  return socketIndex.get(socketId) ?? null;
}

/**
 * Get a player by ID. Throws if not found.
 *
 * @param {string} playerId
 * @returns {Player}
 */
function getPlayer(playerId) {
  if (!_room) throw new RoomError('No active room', ERROR_CODE.ROOM_NOT_FOUND);
  const player = _room.players.get(playerId);
  if (!player) {
    throw new RoomError(`Player ${playerId} not found`, ERROR_CODE.PLAYER_NOT_FOUND);
  }
  return player;
}

/**
 * Return a serializable snapshot of all players sorted by score.
 * Strips internal fields (socketId, etc.) safe to broadcast to clients.
 *
 * @returns {Array<{ id, nickname, score, connected, role }>}
 */
function getPlayerSnapshot() {
  if (!_room) return [];
  return [..._room.players.values()]
    .map(({ id, nickname, score, connected, role }) => ({
      id, nickname, score, connected, role,
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Add points to a player's cumulative score.
 *
 * @param {string} playerId
 * @param {number} points
 */
function addScore(playerId, points) {
  const player = getPlayer(playerId);
  player.score += points;
}

/**
 * Check whether a socket belongs to the host of the current room.
 *
 * @param {string} socketId
 * @returns {boolean}
 */
function isHost(socketId) {
  const entry = socketIndex.get(socketId);
  if (!entry || !_room) return false;
  return _room.players.get(entry.playerId)?.role === ROLE.HOST;
}

/**
 * Whether a room currently exists.
 *
 * @returns {boolean}
 */
function roomExists() {
  return _room !== null;
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Generate a short stable player ID unique within a session.
 *
 * @returns {string}
 */
function _generatePlayerId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Room lifecycle
  createRoom,
  restoreFromCheckpoint,
  destroyRoom,
  schedulePostGameCleanup,

  // Host
  reconnectHost,
  generateAdminToken,
  validateAdminToken,
  getAdminToken,

  // Players
  joinRoom,
  reconnectPlayer,
  handleDisconnect,

  // Getters
  getRoom,
  getRoomOrNull,
  getRoomCode,
  getRoomBySocket,
  getPlayer,
  getPlayerSnapshot,
  addScore,
  isHost,
  roomExists,
};