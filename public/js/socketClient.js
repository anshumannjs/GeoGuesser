/**
 * socketClient.js
 * Shared Socket.io connection manager used by both playerApp.js and hostApp.js.
 *
 * Changes from previous version:
 *  - adminAuth()  — sends C_ADMIN_AUTH (host password flow)
 *  - rejoin()     — sends C_REJOIN (playerId-based reconnect for both roles)
 *  - nickname is now persisted in sessionStorage so players never re-type it
 *  - adminToken is stored/retrieved from sessionStorage for host reconnect
 */

/* global io, EVENTS, SESSION_KEYS */

const SocketClient = (() => {

  // ── State ─────────────────────────────────────────────────────────────────

  let _socket    = null;
  let _roomCode  = null;
  let _playerId  = null;
  let _listeners = {};

  // ── Connect ───────────────────────────────────────────────────────────────

  /**
   * Initialise the socket connection.
   * Safe to call multiple times — returns existing socket if already live.
   *
   * @returns {SocketIO.Socket}
   */
  function connect() {
    if (_socket) return _socket;

    _socket = io(window.location.origin, {
      transports:           ['websocket', 'polling'],
      reconnection:          true,
      reconnectionDelay:     1000,
      reconnectionDelayMax:  5000,
      reconnectionAttempts:  20,
      upgrade:               true,
    });

    // ── Lifecycle events ─────────────────────────────────────────────────

    _socket.on('connect', () => {
      console.info(`[socket] Connected: ${_socket.id}`);
      _emit('_connected', { socketId: _socket.id });
    });

    _socket.on('disconnect', (reason) => {
      console.warn(`[socket] Disconnected: ${reason}`);
      _emit('_disconnected', { reason });
    });

    _socket.on('connect_error', (err) => {
      console.error('[socket] Connection error:', err.message);
      _emit('_connect_error', { message: err.message });
    });

    _socket.on('reconnect', (attempt) => {
      console.info(`[socket] Reconnected after ${attempt} attempts`);
      _emit('_reconnected', { attempt });
    });

    _socket.on('reconnect_attempt', (attempt) => {
      console.info(`[socket] Reconnect attempt ${attempt}…`);
    });

    _socket.on('reconnect_failed', () => {
      console.error('[socket] All reconnect attempts failed');
      _emit('_reconnect_failed', {});
    });

    // ── Forward all server → client game events to internal bus ──────────

    const gameEvents = Object.values(EVENTS).filter((e) => e.startsWith('s:'));
    gameEvents.forEach((event) => {
      _socket.on(event, (payload) => {
        console.debug(`[socket] ← ${event}`, payload);
        _emit(event, payload);
      });
    });

    return _socket;
  }

  // ── Internal Event Bus ────────────────────────────────────────────────────

  function _emit(event, payload) {
    (_listeners[event] ?? []).forEach((cb) => {
      try { cb(payload); }
      catch (err) { console.error(`[socket] Listener error on "${event}":`, err); }
    });
  }

  /**
   * Subscribe to a socket event or internal lifecycle event.
   *
   * @param {string}   event
   * @param {Function} callback
   * @returns {Function}  Unsubscribe function
   */
  function on(event, callback) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(callback);
    return () => {
      _listeners[event] = (_listeners[event] ?? []).filter((cb) => cb !== callback);
    };
  }

  // ── Raw Emit ──────────────────────────────────────────────────────────────

  /**
   * @param {string} event
   * @param {Object} [payload={}]
   */
  function send(event, payload = {}) {
    if (!_socket?.connected) {
      console.warn(`[socket] Cannot emit "${event}" — not connected`);
      return;
    }
    console.debug(`[socket] → ${event}`, payload);
    _socket.emit(event, payload);
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  /**
   * Host submits admin password to create/access the singleton room.
   * On success server emits S_ADMIN_AUTH_OK with roomCode + adminToken.
   *
   * @param {string} password
   * @param {string} nickname
   */
  function adminAuth(password, nickname) {
    send(EVENTS.C_ADMIN_AUTH, { password, nickname });
  }

  /**
   * Rejoin an existing session using stored sessionStorage credentials.
   * Works for both host (sends adminToken) and players (sends playerId).
   * Called automatically on page load if a valid session is found.
   *
   * @param {Object} opts
   * @param {string} opts.playerId
   * @param {string} opts.nickname
   * @param {string} [opts.adminToken]  Host only
   */
  function rejoin({ playerId, nickname, adminToken }) {
    send(EVENTS.C_REJOIN, {
      playerId,
      nickname,
      ...(adminToken ? { adminToken } : {}),
    });
  }

  // ── Game Actions ──────────────────────────────────────────────────────────

  /**
   * Player joins a room for the first time (LOBBY state only).
   *
   * @param {string} roomCode
   * @param {string} nickname
   */
  function joinRoom(roomCode, nickname) {
    _roomCode = roomCode.trim().toUpperCase();
    send(EVENTS.C_JOIN, { roomCode: _roomCode, nickname });
  }

  /** Host starts the game. */
  function startGame() {
    if (!_roomCode) return;
    send(EVENTS.C_HOST_START, { roomCode: _roomCode });
  }

  /** Host advances past reveal or leaderboard. */
  function hostNext() {
    if (!_roomCode) return;
    send(EVENTS.C_HOST_NEXT, { roomCode: _roomCode });
  }

  /**
   * Host force-ends an active round early.
   * Separate event from hostNext() — wires to forceEndRound() on server.
   */
  function hostEndRound() {
    if (!_roomCode) return;
    send(EVENTS.C_HOST_END_ROUND, { roomCode: _roomCode });
  }

  /**
   * Player submits a guess.
   *
   * @param {number} roundIndex
   * @param {{ lat: number, lng: number }|{ x: number, y: number }} coord
   */
  function submitGuess(roundIndex, coord) {
    if (!_roomCode) return;
    send(EVENTS.C_GUESS_SUBMIT, { roomCode: _roomCode, roundIndex, coord });
  }

  // ── Session Storage ───────────────────────────────────────────────────────

  /**
   * Persist session after successful join or rejoin.
   * Stores everything needed to auto-rejoin on page refresh.
   *
   * @param {Object} opts
   * @param {string} opts.roomCode
   * @param {string} opts.playerId
   * @param {string} opts.nickname
   * @param {string} opts.role           ROLE.HOST | ROLE.PLAYER
   * @param {string} [opts.adminToken]   Host only
   */
  function setSession({ roomCode, playerId, nickname, role, adminToken }) {
    _roomCode = roomCode;
    _playerId = playerId;

    sessionStorage.setItem(SESSION_KEYS.ROOM_CODE,   roomCode);
    sessionStorage.setItem(SESSION_KEYS.PLAYER_ID,   playerId);
    sessionStorage.setItem(SESSION_KEYS.NICKNAME,    nickname);
    sessionStorage.setItem(SESSION_KEYS.ROLE,        role);

    if (adminToken) {
      sessionStorage.setItem(SESSION_KEYS.ADMIN_TOKEN, adminToken);
    }
  }

  /**
   * Retrieve the saved session from sessionStorage.
   *
   * @returns {{
   *   roomCode:   string|null,
   *   playerId:   string|null,
   *   nickname:   string|null,
   *   role:       string|null,
   *   adminToken: string|null,
   * }}
   */
  function getSavedSession() {
    return {
      roomCode:   sessionStorage.getItem(SESSION_KEYS.ROOM_CODE),
      playerId:   sessionStorage.getItem(SESSION_KEYS.PLAYER_ID),
      nickname:   sessionStorage.getItem(SESSION_KEYS.NICKNAME),
      role:       sessionStorage.getItem(SESSION_KEYS.ROLE),
      adminToken: sessionStorage.getItem(SESSION_KEYS.ADMIN_TOKEN),
    };
  }

  /**
   * Clear all session data (called on game over or explicit logout).
   */
  function clearSession() {
    _roomCode = null;
    _playerId = null;
    Object.values(SESSION_KEYS).forEach((key) => sessionStorage.removeItem(key));
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  function getRoomCode()  { return _roomCode; }
  function getPlayerId()  { return _playerId; }
  function isConnected()  { return _socket?.connected ?? false; }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    connect,
    on,
    send,
    adminAuth,
    rejoin,
    joinRoom,
    startGame,
    hostNext,
    hostEndRound,
    submitGuess,
    setSession,
    getSavedSession,
    clearSession,
    getRoomCode,
    getPlayerId,
    isConnected,
  };

})();