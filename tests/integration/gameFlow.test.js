'use strict';

const http    = require('http');
const express = require('express');
const fs      = require('fs');
const { Server }   = require('socket.io');
const { io: ClientIO } = require('socket.io-client');
const { registerSocketHandlers } = require('../../server/socketHandlers');
const { EVENTS, GAME_STATE } = require('../../server/constants');

// ── Mock round data ───────────────────────────────────────────────────────────

const mockWorldRounds = [
  { id: 'w01', type: 'world',  label: 'Round 1', panoId: 'abc', photoUrl: '/w01.jpg', lat: 48.8,  lng: 2.2  },
  { id: 'w02', type: 'world',  label: 'Round 2', panoId: 'def', photoUrl: '/w02.jpg', lat: 51.5,  lng: -0.1 },
];
const mockCampusRounds = [
  { id: 'c01', type: 'campus', label: 'Campus 1', photoUrl: '/c01.jpg', x: 0.4, y: 0.6 },
  { id: 'c02', type: 'campus', label: 'Campus 2', photoUrl: '/c02.jpg', x: 0.7, y: 0.3 },
];

let httpServer;
let io;
let serverUrl;

beforeAll((done) => {
  const readSpy = jest.spyOn(fs, 'readFileSync');
  readSpy.mockImplementation((filePath, ...rest) => {
    if (filePath.includes('worldRounds.json'))  return JSON.stringify(mockWorldRounds);
    if (filePath.includes('campusRounds.json')) return JSON.stringify(mockCampusRounds);
    return jest.requireActual('fs').readFileSync(filePath, ...rest);
  });

  const app = express();
  httpServer = http.createServer(app);
  io = new Server(httpServer, { cors: { origin: '*' } });
  registerSocketHandlers(io);

  httpServer.listen(0, () => {
    serverUrl = `http://localhost:${httpServer.address().port}`;
    done();
  });
});

afterAll((done) => {
  io.close();
  httpServer.close(done);
  jest.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClient() {
  return ClientIO(serverUrl, { transports: ['websocket'], autoConnect: false });
}

function waitFor(socket, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Timeout waiting for "${event}" on ${socket.id}`)),
      timeout
    );
    socket.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

async function setupRoom(playerCount = 2) {
  const host = makeClient();
  host.connect();
  await waitFor(host, 'connect');
  host.emit(EVENTS.C_HOST_CREATE, { nickname: 'Host' });
  const hostJoin = await waitFor(host, EVENTS.S_ROOM_JOINED);
  const { roomCode } = hostJoin;

  const players = [];
  for (let i = 0; i < playerCount; i++) {
    const c = makeClient();
    c.connect();
    await waitFor(c, 'connect');
    c.emit(EVENTS.C_JOIN, { roomCode, nickname: `Player${i + 1}` });
    await waitFor(c, EVENTS.S_ROOM_JOINED);
    players.push(c);
  }

  return { host, players, roomCode };
}

function disconnectAll(host, players) {
  host.disconnect();
  players.forEach((p) => p.disconnect());
}

// ── Full game flow ────────────────────────────────────────────────────────────

describe('Full game flow', () => {

  test('host starts game — all clients receive S_GAME_COUNTDOWN', async () => {
    const { host, players, roomCode } = await setupRoom(3);

    const promises = [host, ...players].map((c) =>
      waitFor(c, EVENTS.S_GAME_COUNTDOWN)
    );

    host.emit(EVENTS.C_HOST_START, { roomCode });
    const results = await Promise.all(promises);

    results.forEach((r) => {
      expect(r).toHaveProperty('countdownMs');
      expect(r).toHaveProperty('totalRounds');
    });

    disconnectAll(host, players);
  }, 15000);

  test('after countdown all clients receive S_ROUND_START', async () => {
    const { host, players, roomCode } = await setupRoom(2);

    const promises = [host, ...players].map((c) =>
      waitFor(c, EVENTS.S_ROUND_START, 10000)
    );

    host.emit(EVENTS.C_HOST_START, { roomCode });
    const results = await Promise.all(promises);

    results.forEach((r) => {
      expect(r).toHaveProperty('round');
      expect(r).toHaveProperty('roundIndex');
      expect(r).toHaveProperty('durationMs');
      expect(r).toHaveProperty('endsAt');
      // Answer coordinates must NOT be in the payload
      expect(r.round).not.toHaveProperty('lat');
      expect(r.round).not.toHaveProperty('lng');
      expect(r.round).not.toHaveProperty('x');
      expect(r.round).not.toHaveProperty('y');
    });

    disconnectAll(host, players);
  }, 15000);

  test('player submits guess and receives S_GUESS_ACK', async () => {
    const { host, players, roomCode } = await setupRoom(2);

    host.emit(EVENTS.C_HOST_START, { roomCode });

    // Wait for round to start
    await waitFor(players[0], EVENTS.S_ROUND_START, 10000);

    players[0].emit(EVENTS.C_GUESS_SUBMIT, {
      roomCode,
      roundIndex: 0,
      coord: { lat: 48.8, lng: 2.2 },
    });

    const ack = await waitFor(players[0], EVENTS.S_GUESS_ACK);
    expect(ack.accepted).toBe(true);
    expect(ack.guessCount).toBe(1);

    disconnectAll(host, players);
  }, 15000);

  test('second guess from same player is rejected', async () => {
    const { host, players, roomCode } = await setupRoom(2);

    host.emit(EVENTS.C_HOST_START, { roomCode });
    await waitFor(players[0], EVENTS.S_ROUND_START, 10000);

    players[0].emit(EVENTS.C_GUESS_SUBMIT, {
      roomCode,
      roundIndex: 0,
      coord: { lat: 48.8, lng: 2.2 },
    });
    await waitFor(players[0], EVENTS.S_GUESS_ACK);

    // Second guess
    players[0].emit(EVENTS.C_GUESS_SUBMIT, {
      roomCode,
      roundIndex: 0,
      coord: { lat: 51.5, lng: -0.1 },
    });
    const ack2 = await waitFor(players[0], EVENTS.S_GUESS_ACK);
    expect(ack2.accepted).toBe(false);

    disconnectAll(host, players);
  }, 15000);

  test('when all players guess early round ends and reveal fires', async () => {
    const { host, players, roomCode } = await setupRoom(1); // 1 player = fast

    host.emit(EVENTS.C_HOST_START, { roomCode });

    const roundStart = await waitFor(players[0], EVENTS.S_ROUND_START, 10000);

    players[0].emit(EVENTS.C_GUESS_SUBMIT, {
      roomCode,
      roundIndex: roundStart.roundIndex,
      coord: { lat: 48.8, lng: 2.2 },
    });

    // Round should end early and reveal should fire
    const reveal = await waitFor(players[0], EVENTS.S_ROUND_REVEAL, 8000);
    expect(reveal).toHaveProperty('answer');
    expect(reveal).toHaveProperty('scores');
    expect(reveal).toHaveProperty('leaderboard');
    expect(reveal.scores[0]).toHaveProperty('points');

    disconnectAll(host, players);
  }, 20000);

  test('host advance moves from reveal to leaderboard', async () => {
    const { host, players, roomCode } = await setupRoom(1);

    host.emit(EVENTS.C_HOST_START, { roomCode });
    const roundStart = await waitFor(players[0], EVENTS.S_ROUND_START, 10000);

    players[0].emit(EVENTS.C_GUESS_SUBMIT, {
      roomCode,
      roundIndex: roundStart.roundIndex,
      coord: { lat: 48.8, lng: 2.2 },
    });

    await waitFor(host, EVENTS.S_ROUND_REVEAL, 8000);

    // Host advances
    host.emit(EVENTS.C_HOST_NEXT, { roomCode });

    const lb = await waitFor(host, EVENTS.S_LEADERBOARD, 5000);
    expect(lb).toHaveProperty('players');
    expect(lb).toHaveProperty('roundIndex');
    expect(lb).toHaveProperty('totalRounds');

    disconnectAll(host, players);
  }, 25000);

  test('S_ROUND_REVEAL contains correct location info', async () => {
    const { host, players, roomCode } = await setupRoom(1);

    host.emit(EVENTS.C_HOST_START, { roomCode });
    const roundStart = await waitFor(players[0], EVENTS.S_ROUND_START, 10000);

    players[0].emit(EVENTS.C_GUESS_SUBMIT, {
      roomCode,
      roundIndex: roundStart.roundIndex,
      coord: { lat: 48.8, lng: 2.2 },
    });

    const reveal = await waitFor(players[0], EVENTS.S_ROUND_REVEAL, 8000);

    // Answer must contain correct coordinate type
    if (roundStart.round.type === 'world') {
      expect(reveal.answer).toHaveProperty('lat');
      expect(reveal.answer).toHaveProperty('lng');
    } else {
      expect(reveal.answer).toHaveProperty('x');
      expect(reveal.answer).toHaveProperty('y');
    }

    disconnectAll(host, players);
  }, 25000);

  test('leaderboard scores increase correctly across rounds', async () => {
    const { host, players, roomCode } = await setupRoom(1);

    host.emit(EVENTS.C_HOST_START, { roomCode });

    // Play through 2 rounds
    for (let i = 0; i < 2; i++) {
      const roundStart = await waitFor(players[0], EVENTS.S_ROUND_START, 10000);
      players[0].emit(EVENTS.C_GUESS_SUBMIT, {
        roomCode,
        roundIndex: roundStart.roundIndex,
        coord: { lat: 0, lng: 0 },
      });
      await waitFor(players[0], EVENTS.S_ROUND_REVEAL, 8000);
      host.emit(EVENTS.C_HOST_NEXT, { roomCode });
      const lb = await waitFor(host, EVENTS.S_LEADERBOARD, 5000);

      const playerEntry = lb.players.find((p) => p.nickname === 'Player1');
      expect(playerEntry.score).toBeGreaterThan(0);

      if (i < 1) {
        // More rounds remain — advance to next
        host.emit(EVENTS.C_HOST_NEXT, { roomCode });
      }
    }

    disconnectAll(host, players);
  }, 60000);
});