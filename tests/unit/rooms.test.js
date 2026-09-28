'use strict';

// Reset module between tests since rooms uses in-memory state
let rooms;

beforeEach(() => {
  jest.resetModules();
  rooms = require('../../server/rooms');
});

describe('createRoom()', () => {

  test('creates a room with a 5-character code', () => {
    const { room } = rooms.createRoom('socket1', 'HostUser');
    expect(room.code).toHaveLength(5);
  });

  test('room code contains only valid characters (no 0, O, 1, I, L)', () => {
    const { room } = rooms.createRoom('socket1', 'HostUser');
    expect(room.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]+$/);
  });

  test('host is added to room players', () => {
    const { room, host } = rooms.createRoom('socket1', 'HostUser');
    expect(room.players.has(host.id)).toBe(true);
  });

  test('host has role HOST', () => {
    const { host } = rooms.createRoom('socket1', 'HostUser');
    expect(host.role).toBe('host');
  });

  test('room starts in LOBBY state', () => {
    const { room } = rooms.createRoom('socket1', 'HostUser');
    expect(room.state).toBe('LOBBY');
  });

  test('two rooms have different codes', () => {
    const { room: r1 } = rooms.createRoom('socket1', 'Host1');
    const { room: r2 } = rooms.createRoom('socket2', 'Host2');
    expect(r1.code).not.toBe(r2.code);
  });

  test('nickname is trimmed', () => {
    const { host } = rooms.createRoom('socket1', '  HostUser  ');
    expect(host.nickname).toBe('HostUser');
  });
});

describe('joinRoom()', () => {

  test('adds player to existing room', () => {
    const { room }   = rooms.createRoom('socket1', 'Host');
    const { player } = rooms.joinRoom(room.code, 'socket2', 'Alice');
    expect(room.players.has(player.id)).toBe(true);
  });

  test('player has role PLAYER', () => {
    const { room }   = rooms.createRoom('socket1', 'Host');
    const { player } = rooms.joinRoom(room.code, 'socket2', 'Alice');
    expect(player.role).toBe('player');
  });

  test('throws ROOM_NOT_FOUND for invalid room code', () => {
    expect(() => rooms.joinRoom('XXXXX', 'socket2', 'Alice'))
      .toThrow(expect.objectContaining({ code: 'ROOM_NOT_FOUND' }));
  });

  test('throws NICKNAME_TAKEN for duplicate nickname', () => {
    const { room } = rooms.createRoom('socket1', 'Host');
    rooms.joinRoom(room.code, 'socket2', 'Alice');
    expect(() => rooms.joinRoom(room.code, 'socket3', 'Alice'))
      .toThrow(expect.objectContaining({ code: 'NICKNAME_TAKEN' }));
  });

  test('nickname comparison is case-insensitive', () => {
    const { room } = rooms.createRoom('socket1', 'Host');
    rooms.joinRoom(room.code, 'socket2', 'Alice');
    expect(() => rooms.joinRoom(room.code, 'socket3', 'ALICE'))
      .toThrow(expect.objectContaining({ code: 'NICKNAME_TAKEN' }));
  });

  test('throws ROOM_FULL when max players reached', () => {
    const { MAX_PLAYERS } = require('../../server/constants');
    const { room } = rooms.createRoom('socket1', 'Host');

    // Fill the room (host counts as 1)
    for (let i = 1; i < MAX_PLAYERS; i++) {
      rooms.joinRoom(room.code, `socket${i + 1}`, `Player${i}`);
    }

    expect(() => rooms.joinRoom(room.code, 'socketOver', 'OneMore'))
      .toThrow(expect.objectContaining({ code: 'ROOM_FULL' }));
  });

  test('throws ROOM_ALREADY_STARTED when game is active', () => {
    const { room } = rooms.createRoom('socket1', 'Host');
    room.state = 'ROUND_ACTIVE'; // simulate started game
    expect(() => rooms.joinRoom(room.code, 'socket2', 'Alice'))
      .toThrow(expect.objectContaining({ code: 'ROOM_ALREADY_STARTED' }));
  });
});

describe('handleDisconnect()', () => {

  test('marks player as disconnected', () => {
    const { room }   = rooms.createRoom('socket1', 'Host');
    const { player } = rooms.joinRoom(room.code, 'socket2', 'Alice');
    rooms.handleDisconnect('socket2');
    expect(player.connected).toBe(false);
  });

  test('returns null for unknown socket', () => {
    const result = rooms.handleDisconnect('unknown_socket');
    expect(result).toBeNull();
  });

  test('sets lastSeenAt on disconnect', () => {
    const { room }   = rooms.createRoom('socket1', 'Host');
    rooms.joinRoom(room.code, 'socket2', 'Alice');
    rooms.handleDisconnect('socket2');
    const player = [...room.players.values()].find((p) => p.nickname === 'Alice');
    expect(player.lastSeenAt).not.toBeNull();
  });
});

describe('reconnectPlayer()', () => {

  test('reconnects a disconnected player', () => {
    const { room }   = rooms.createRoom('socket1', 'Host');
    const { player } = rooms.joinRoom(room.code, 'socket2', 'Alice');
    rooms.handleDisconnect('socket2');

    const result = rooms.reconnectPlayer(room.code, 'socket3', 'Alice');
    expect(result).not.toBeNull();
    expect(result.player.connected).toBe(true);
    expect(result.player.socketId).toBe('socket3');
  });

  test('returns null for non-existent room', () => {
    const result = rooms.reconnectPlayer('XXXXX', 'socket3', 'Alice');
    expect(result).toBeNull();
  });

  test('returns null if player is still connected (not disconnected)', () => {
    const { room } = rooms.createRoom('socket1', 'Host');
    rooms.joinRoom(room.code, 'socket2', 'Alice');
    // Alice is still connected — should not allow reconnect
    const result = rooms.reconnectPlayer(room.code, 'socket3', 'Alice');
    expect(result).toBeNull();
  });
});

describe('getPlayerSnapshot()', () => {

  test('returns players sorted by score descending', () => {
    const { room }   = rooms.createRoom('socket1', 'Host');
    rooms.joinRoom(room.code, 'socket2', 'Alice');
    rooms.joinRoom(room.code, 'socket3', 'Bob');

    rooms.addScore(room.code, [...room.players.values()].find((p) => p.nickname === 'Bob').id, 500);

    const snapshot = rooms.getPlayerSnapshot(room.code);
    // Bob has more score — should be first (after host)
    const players  = snapshot.filter((p) => p.role === 'player');
    expect(players[0].nickname).toBe('Bob');
  });

  test('does not include socketId in snapshot', () => {
    const { room } = rooms.createRoom('socket1', 'Host');
    const snapshot = rooms.getPlayerSnapshot(room.code);
    snapshot.forEach((p) => {
      expect(p).not.toHaveProperty('socketId');
    });
  });
});

describe('addScore()', () => {

  test('adds points to player cumulative score', () => {
    const { room }   = rooms.createRoom('socket1', 'Host');
    const { player } = rooms.joinRoom(room.code, 'socket2', 'Alice');
    rooms.addScore(room.code, player.id, 500);
    rooms.addScore(room.code, player.id, 300);
    expect(player.score).toBe(800);
  });
});

describe('isHost()', () => {

  test('returns true for host socket', () => {
    const { room } = rooms.createRoom('socket1', 'Host');
    expect(rooms.isHost(room.code, 'socket1')).toBe(true);
  });

  test('returns false for player socket', () => {
    const { room }   = rooms.createRoom('socket1', 'Host');
    rooms.joinRoom(room.code, 'socket2', 'Alice');
    expect(rooms.isHost(room.code, 'socket2')).toBe(false);
  });

  test('returns false for unknown socket', () => {
    const { room } = rooms.createRoom('socket1', 'Host');
    expect(rooms.isHost(room.code, 'unknown')).toBe(false);
  });
});