/**
 * socketClient.js
 * Shared Socket.io connection manager used by both playerApp.js and hostApp.js.
 *
 * Responsibilities:
 *  - Create and expose the socket instance
 *  - Handle connection lifecycle logging / toast feedback
 *  - Provide a typed emit helper that attaches roomCode automatically
 *  - Expose a simple event bus so app modules can subscribe without
 *    importing socket directly
 */

/* global io, EVENTS */

const SocketClient = (() => {
  // ── State ────────────────────────────────────────────────────────────────

  let _socket     = null;
  let _roomCode   = null;
  let _playerId   = null;
  let _listeners  = {}; // eventName → [callbacks]

  // ── Init ─────────────────────────────────────────────────────────────────

  /**
   * Initialise the socket connection.
   * Safe to call multiple times — returns existing socket if already connected.
   *
   * @returns {SocketIO.Socket}
   */
  function connect() {
    if (_socket) return _socket;

    _socket = io({
      transports:       ['websocket', 'polling'],
      reconnection:      true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 10,
    });

    // ── Socket lifecycle events ──────────────────────────────────────────

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
      console.info(`[socket] Reconnect attempt ${attempt}...`);
    });

    _socket.on('reconnect_failed', () => {
      console.error('[socket] All reconnect attempts failed');
      _emit('_reconnect_failed', {});
    });

    // ── Game events — forward to internal bus ────────────────────────────

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

  /**
   * Dispatch an internal event to all registered listeners.
   *
   * @param {string} event
   * @param {*}      payload
   */
  function _emit(event, payload) {
    (_listeners[event] ?? []).forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[socket] Listener error on "${event}":`, err);
      }
    });
  }

  /**
   * Subscribe to an event (socket event or internal lifecycle event).
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

  // ── Emit Helpers ──────────────────────────────────────────────────────────

  /**
   * Emit a socket event to the server.
   * Logs the event name and payload for debugging.
   *
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

  // ── Convenience Methods ───────────────────────────────────────────────────

  /**
   * Emit C_HOST_CREATE — creates a new room.
   *
   * @param {string} nickname
   */
  function createRoom(nickname) {
    send(EVENTS.C_HOST_CREATE, { nickname });
  }

  /**
   * Emit C_JOIN — join or reconnect to an existing room.
   *
   * @param {string} roomCode
   * @param {string} nickname
   */
  function joinRoom(roomCode, nickname) {
    _roomCode = roomCode.trim().toUpperCase();
    send(EVENTS.C_JOIN, { roomCode: _roomCode, nickname });
  }

  /**
   * Emit C_HOST_START — start the game (host only).
   */
  function startGame() {
    if (!_roomCode) return;
    send(EVENTS.C_HOST_START, { roomCode: _roomCode });
  }

  /**
   * Emit C_HOST_NEXT — advance past reveal/leaderboard (host only).
   */
  function hostNext() {
    if (!_roomCode) return;
    send(EVENTS.C_HOST_NEXT, { roomCode: _roomCode });
  }

  /**
   * Emit C_GUESS_SUBMIT — submit a guess for the current round.
   *
   * @param {number} roundIndex
   * @param {{ lat: number, lng: number }|{ x: number, y: number }} coord
   */
  function submitGuess(roundIndex, coord) {
    if (!_roomCode) return;
    send(EVENTS.C_GUESS_SUBMIT, { roomCode: _roomCode, roundIndex, coord });
  }

  // ── Session ───────────────────────────────────────────────────────────────

  /**
   * Store session info after a successful join.
   *
   * @param {string} roomCode
   * @param {string} playerId
   */
  function setSession(roomCode, playerId) {
    _roomCode = roomCode;
    _playerId = playerId;
    // Persist in sessionStorage for reconnection
    sessionStorage.setItem('gg_room', roomCode);
    sessionStorage.setItem('gg_pid',  playerId);
  }

  /**
   * Retrieve any previously saved session (for auto-reconnect on page refresh).
   *
   * @returns {{ roomCode: string|null, playerId: string|null }}
   */
  function getSavedSession() {
    return {
      roomCode: sessionStorage.getItem('gg_room'),
      playerId: sessionStorage.getItem('gg_pid'),
    };
  }

  /**
   * Clear the saved session (e.g. after game over).
   */
  function clearSession() {
    _roomCode = null;
    _playerId = null;
    sessionStorage.removeItem('gg_room');
    sessionStorage.removeItem('gg_pid');
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  /** @returns {string|null} */
  function getRoomCode() { return _roomCode; }

  /** @returns {string|null} */
  function getPlayerId() { return _playerId; }

  /** @returns {boolean} */
  function isConnected() { return _socket?.connected ?? false; }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    connect,
    on,
    send,
    createRoom,
    joinRoom,
    startGame,
    hostNext,
    submitGuess,
    setSession,
    getSavedSession,
    clearSession,
    getRoomCode,
    getPlayerId,
    isConnected,
  };
})();