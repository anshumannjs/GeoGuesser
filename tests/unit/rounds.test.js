'use strict';

const fs   = require('fs');
const path = require('path');
const { buildRoundSequence, getRound, getRoundDuration, sanitiseRoundForClient } = require('../../server/rounds');
const { ROUND_TYPE, TIMING } = require('../../server/constants');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const worldRounds = [
  { id: 'w01', type: 'world',  label: 'Round 1', panoId: 'abc', photoUrl: '/p/w01.jpg', lat: 48.8, lng: 2.2, locationHint: 'Paris' },
  { id: 'w02', type: 'world',  label: 'Round 2', panoId: 'def', photoUrl: '/p/w02.jpg', lat: 51.5, lng: -0.1, locationHint: 'London' },
  { id: 'w03', type: 'world',  label: 'Round 3', panoId: 'ghi', photoUrl: '/p/w03.jpg', lat: 35.6, lng: 139.6, locationHint: 'Tokyo' },
];

const campusRounds = [
  { id: 'c01', type: 'campus', label: 'Campus 1', photoUrl: '/c/c01.jpg', x: 0.4, y: 0.6 },
  { id: 'c02', type: 'campus', label: 'Campus 2', photoUrl: '/c/c02.jpg', x: 0.7, y: 0.3 },
];

// ── buildRoundSequence() ──────────────────────────────────────────────────────

describe('buildRoundSequence()', () => {

  test('returns world rounds before campus rounds by default', () => {
    const seq = buildRoundSequence(worldRounds, campusRounds, {
      shuffleCampus: false,
      shuffleWorld:  false,
    });
    const worldEnd = seq.findLastIndex((r) => r.type === ROUND_TYPE.WORLD);
    const campusStart = seq.findIndex((r) => r.type === ROUND_TYPE.CAMPUS);
    expect(worldEnd).toBeLessThan(campusStart);
  });

  test('respects maxWorldRounds limit', () => {
    const seq    = buildRoundSequence(worldRounds, campusRounds, { maxWorldRounds: 2 });
    const worlds = seq.filter((r) => r.type === ROUND_TYPE.WORLD);
    expect(worlds).toHaveLength(2);
  });

  test('respects maxCampusRounds limit', () => {
    const seq    = buildRoundSequence(worldRounds, campusRounds, { maxCampusRounds: 1 });
    const campus = seq.filter((r) => r.type === ROUND_TYPE.CAMPUS);
    expect(campus).toHaveLength(1);
  });

  test('does not exceed available rounds even if max is higher', () => {
    const seq    = buildRoundSequence(worldRounds, campusRounds, { maxWorldRounds: 999 });
    const worlds = seq.filter((r) => r.type === ROUND_TYPE.WORLD);
    expect(worlds).toHaveLength(worldRounds.length);
  });

  test('total length equals world + campus counts', () => {
    const seq = buildRoundSequence(worldRounds, campusRounds, {
      maxWorldRounds:  2,
      maxCampusRounds: 1,
    });
    expect(seq).toHaveLength(3);
  });
});

// ── getRound() ────────────────────────────────────────────────────────────────

describe('getRound()', () => {

  test('returns correct round at valid index', () => {
    const seq   = buildRoundSequence(worldRounds, campusRounds, { shuffleCampus: false, shuffleWorld: false });
    const round = getRound(seq, 0);
    expect(round).toBe(seq[0]);
  });

  test('returns null for out-of-bounds index', () => {
    const seq = buildRoundSequence(worldRounds, campusRounds);
    expect(getRound(seq, 999)).toBeNull();
  });

  test('returns null for negative index', () => {
    const seq = buildRoundSequence(worldRounds, campusRounds);
    expect(getRound(seq, -1)).toBeNull();
  });
});

// ── getRoundDuration() ────────────────────────────────────────────────────────

describe('getRoundDuration()', () => {

  test('returns WORLD_ROUND_DURATION_MS for world rounds', () => {
    const duration = getRoundDuration(worldRounds[0], TIMING);
    expect(duration).toBe(TIMING.WORLD_ROUND_DURATION_MS);
  });

  test('returns CAMPUS_ROUND_DURATION_MS for campus rounds', () => {
    const duration = getRoundDuration(campusRounds[0], TIMING);
    expect(duration).toBe(TIMING.CAMPUS_ROUND_DURATION_MS);
  });

  test('returns custom durationMs if set on the round', () => {
    const round = { ...worldRounds[0], durationMs: 99999 };
    const duration = getRoundDuration(round, TIMING);
    expect(duration).toBe(99999);
  });
});

// ── sanitiseRoundForClient() ──────────────────────────────────────────────────

describe('sanitiseRoundForClient()', () => {

  test('strips lat and lng from world rounds', () => {
    const safe = sanitiseRoundForClient(worldRounds[0]);
    expect(safe).not.toHaveProperty('lat');
    expect(safe).not.toHaveProperty('lng');
  });

  test('keeps non-sensitive world round fields', () => {
    const safe = sanitiseRoundForClient(worldRounds[0]);
    expect(safe).toHaveProperty('id');
    expect(safe).toHaveProperty('label');
    expect(safe).toHaveProperty('photoUrl');
  });

  test('strips x and y from campus rounds', () => {
    const safe = sanitiseRoundForClient(campusRounds[0]);
    expect(safe).not.toHaveProperty('x');
    expect(safe).not.toHaveProperty('y');
  });

  test('keeps non-sensitive campus round fields', () => {
    const safe = sanitiseRoundForClient(campusRounds[0]);
    expect(safe).toHaveProperty('id');
    expect(safe).toHaveProperty('label');
    expect(safe).toHaveProperty('photoUrl');
  });

  test('does not mutate the original round object', () => {
    const original = { ...worldRounds[0] };
    sanitiseRoundForClient(worldRounds[0]);
    expect(worldRounds[0]).toEqual(original);
  });
});