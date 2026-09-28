'use strict';

const http     = require('http');
const express  = require('express');
const { Server } = require('socket.io');
const { io: ClientIO } = require('socket.io-client');
const path     = require('path');
const fs       = require('fs');

const { registerSocketHandlers } = require('../../server/socketHandlers');
const { EVENTS, GAME_STATE, ROLE } = require('../../server/constants');

// ── Test server setup ─────────────────────────────────────────────────────────

let httpServer;
let io;
let serverUrl;

// Mock round data for tests
const mockWorldRounds = [
  { id: 'w01', type: 'world',  label: 'Round 1', panoId: 'abc', photoUrl: '/p/w01.jpg', lat: 48.8, lng: 2.2 },
  { id: 'w02', type: 'world',  label: 'Round 2', panoId: 'def', photoUrl: '/p/w02.jpg', lat: 51.5, lng: -0.1 },
];
const mockCampusRounds = [
  { id: 'c01', type: 'campus', label: 'Campus 1', photoUrl: '/c/c01.jpg', x: 0.4, y: 0.6 },
  { id: 'c02', type: 'campus', label: 'Campus 2', photoUrl: '/c/c02.jpg', x: 0.7, y: 0.3 },
];

beforeAll((done) => {
  // Mock the data files so we don't need real round data on disk
  jest.mock('../../server/data/worldRounds.json',  () => mockWorldRounds,  { virtual: true });
  jest.mock('../../server/data/campusRounds.json', () => mockCampusRounds, { virtual: true });

  const readFileSyncSpy = jest.spyOn(fs, 'readFileSync');
  readFileSyncSpy.mockImplementation((filePath, ...args) => {
    if (filePath.includes('worldRounds.json'))  return JSON.stringify(mockWorldRounds);
    if (filePath.includes('campusRounds.json')) return JSON.stringify(mockCampusRounds);
    return jest.requireActual('fs').readFileSync(filePath, ...args);
  });

  const app = express();
  httpServer = http.createServer(app);
  io = new Server(httpServer, { cors: { origin: '*' } });

  registerSocketHandlers(io);

  httpServer.listen(0, () => {
    const { port } = httpServer.address();
    serverUrl = `http://localhost:${port}`;
    done();
  });
});

afterAll((done) => {
  io.close();
  httpServer.close(done);
  jest.restoreAllMocks();
});

// ── Helper ────────────────────────────────────────────────────────────────────

function createClient(opts = {}) {
  return ClientIO(serverUrl, {
    transports:   ['websocket'],
    autoConnect:  false,
    ...opts,
  });
}

function waitFor(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeout);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// ── C_HOST_CREATE ─────────────────────────────────────────────────────────────

describe('C_HOST_CREATE', () => {

  test('host receives S_ROOM_JOINED with a room code', (done) => {
    const client = createClient();
    client.connect();

    client.once(EVENTS.S_ROOM_JOINED, (payload) => {
      expect(payload.roomCode).toBeDefined();
      expect(payload.roomCode).toHaveLength(5);
      expect(payload.role).toBe(ROLE.HOST);
      client.disconnect();
      done();
    });

    client.once('connect', () => {
      client.emit(EVENTS.C_HOST_CREATE, { nickname: 'TestHost' });
    });
  });

  test('rejects invalid nickname (too short)', (done) => {
    const client = createClient();
    client.connect();

    client.once(EVENTS.S_ERROR, (err) => {
      expect(err.code).toBe('VALIDATION_ERROR');
      client.disconnect();
      done();
    });

    client.once('connect', () => {
      client.emit(EVENTS.C_HOST_CREATE, { nickname: 'X' }); // too short
    });
  });
});

// ── C_JOIN ────────────────────────────────────────────────────────────────────

describe('C_JOIN', () => {

  test('player successfully joins a room', (done) => {
    const host   = createClient();
    const player = createClient();
    let roomCode;

    host.connect();
    host.once(EVENTS.S_ROOM_JOINED, (payload) => {
      roomCode = payload.roomCode;
      player.connect();

      player.once(EVENTS.S_ROOM_JOINED, (joinPayload) => {
        expect(joinPayload.roomCode).toBe(roomCode);
        expect(joinPayload.role).toBe(ROLE.PLAYER);
        host.disconnect();
        player.disconnect();
        done();
      });

      player.once('connect', () => {
        player.emit(EVENTS.C_JOIN, { roomCode, nickname: 'Alice' });
      });
    });

    host.once('connect', () => {
      host.emit(EVENTS.C_HOST_CREATE, { nickname: 'Host' });
    });
  });

  test('host receives S_ROOM_PLAYERS when a player joins', (done) => {
    const host   = createClient();
    const player = createClient();

    host.connect();
    host.once(EVENTS.S_ROOM_JOINED, (payload) => {
      const roomCode = payload.roomCode;

      host.once(EVENTS.S_ROOM_PLAYERS, (update) => {
        const players = update.players.filter((p) => p.role === ROLE.PLAYER);
        expect(players.some((p) => p.nickname === 'Bob')).toBe(true);
        host.disconnect();
        player.disconnect();
        done();
      });

      player.connect();
      player.once('connect', () => {
        player.emit(EVENTS.C_JOIN, { roomCode, nickname: 'Bob' });
      });
    });

    host.once('connect', () => {
      host.emit(EVENTS.C_HOST_CREATE, { nickname: 'Host' });
    });
  });

  test('returns ROOM_NOT_FOUND for invalid code', (done) => {
    const client = createClient();
    client.connect();

    client.once(EVENTS.S_ERROR, (err) => {
      expect(err.code).toBe('ROOM_NOT_FOUND');
      client.disconnect();
      done();
    });

    client.once('connect', () => {
      client.emit(EVENTS.C_JOIN, { roomCode: 'XXXXX', nickname: 'Alice' });
    });
  });

  test('returns NICKNAME_TAKEN for duplicate nickname', (done) => {
    const host    = createClient();
    const player1 = createClient();
    const player2 = createClient();

    host.connect();
    host.once(EVENTS.S_ROOM_JOINED, ({ roomCode }) => {
      player1.connect();
      player1.once('connect', () => {
        player1.emit(EVENTS.C_JOIN, { roomCode, nickname: 'Alice' });
      });

      player1.once(EVENTS.S_ROOM_JOINED, () => {
        player2.connect();
        player2.once(EVENTS.S_ERROR, (err) => {
          expect(err.code).toBe('NICKNAME_TAKEN');
          host.disconnect();
          player1.disconnect();
          player2.disconnect();
          done();
        });
        player2.once('connect', () => {
          player2.emit(EVENTS.C_JOIN, { roomCode, nickname: 'Alice' });
        });
      });
    });

    host.once('connect', () => {
      host.emit(EVENTS.C_HOST_CREATE, { nickname: 'Host' });
    });
  });
});

// ── C_HOST_START ──────────────────────────────────────────────────────────────

describe('C_HOST_START', () => {

  test('non-host cannot start game', (done) => {
    const host   = createClient();
    const player = createClient();

    host.connect();
    host.once(EVENTS.S_ROOM_JOINED, ({ roomCode }) => {
      player.connect();
      player.once('connect', () => {
        player.emit(EVENTS.C_JOIN, { roomCode, nickname: 'Alice' });
      });

      player.once(EVENTS.S_ROOM_JOINED, () => {
        player.emit(EVENTS.C_HOST_START, { roomCode });

        player.once(EVENTS.S_ERROR, (err) => {
          expect(err.code).toBe('UNAUTHORIZED');
          host.disconnect();
          player.disconnect();
          done();
        });
      });
    });

    host.once('connect', () => {
      host.emit(EVENTS.C_HOST_CREATE, { nickname: 'Host' });
    });
  });

  test('host can start game and all clients receive S_GAME_COUNTDOWN', (done) => {
    const host   = createClient();
    const player = createClient();

    host.connect();
    host.once(EVENTS.S_ROOM_JOINED, ({ roomCode }) => {
      player.connect();
      player.once('connect', () => {
        player.emit(EVENTS.C_JOIN, { roomCode, nickname: 'Alice' });
      });

      player.once(EVENTS.S_ROOM_JOINED, () => {
        let countdownCount = 0;

        function onCountdown() {
          countdownCount++;
          if (countdownCount === 2) {
            host.disconnect();
            player.disconnect();
            done();
          }
        }

        host.once(EVENTS.S_GAME_COUNTDOWN, onCountdown);
        player.once(EVENTS.S_GAME_COUNTDOWN, onCountdown);

        host.emit(EVENTS.C_HOST_START, { roomCode });
      });
    });

    host.once('connect', () => {
      host.emit(EVENTS.C_HOST_CREATE, { nickname: 'Host' });
    });
  }, 10000);
});

// ── C_GUESS_SUBMIT ────────────────────────────────────────────────────────────

describe('C_GUESS_SUBMIT', () => {

  test('returns ROUND_NOT_ACTIVE when no round is active', (done) => {
    const host   = createClient();
    const player = createClient();

    host.connect();
    host.once(EVENTS.S_ROOM_JOINED, ({ roomCode }) => {
      player.connect();
      player.once('connect', () => {
        player.emit(EVENTS.C_JOIN, { roomCode, nickname: 'Alice' });
      });

      player.once(EVENTS.S_ROOM_JOINED, () => {
        player.emit(EVENTS.C_GUESS_SUBMIT, {
          roomCode,
          roundIndex: 0,
          coord: { lat: 48.8, lng: 2.2 },
        });

        player.once(EVENTS.S_ERROR, (err) => {
          expect(err.code).toBe('UNAUTHORIZED'); // no active round
          host.disconnect();
          player.disconnect();
          done();
        });
      });
    });

    host.once('connect', () => {
      host.emit(EVENTS.C_HOST_CREATE, { nickname: 'Host' });
    });
  });

  test('validates coord payload — rejects missing fields', (done) => {
    const host   = createClient();
    const player = createClient();

    host.connect();
    host.once(EVENTS.S_ROOM_JOINED, ({ roomCode }) => {
      player.connect();
      player.once('connect', () => {
        player.emit(EVENTS.C_JOIN, { roomCode, nickname: 'Alice' });
      });

      player.once(EVENTS.S_ROOM_JOINED, () => {
        player.emit(EVENTS.C_GUESS_SUBMIT, {
          roomCode,
          roundIndex: 0,
          coord: { lat: 'not-a-number', lng: 2.2 }, // invalid
        });

        player.once(EVENTS.S_ERROR, (err) => {
          expect(err.code).toBe('VALIDATION_ERROR');
          host.disconnect();
          player.disconnect();
          done();
        });
      });
    });

    host.once('connect', () => {
      host.emit(EVENTS.C_HOST_CREATE, { nickname: 'Host' });
    });
  });
});