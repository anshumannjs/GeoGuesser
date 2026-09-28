'use strict';

const { scoreRound, buildLeaderboard, buildRevealPayload } = require('../../server/scoring');
const { ROUND_TYPE, SCORING } = require('../../server/constants');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const worldAnswer = { lat: 48.8584, lng: 2.2945 };
const campusAnswer = { x: 0.5, y: 0.5 };

function makeWorldGuesses(count) {
  return Array.from({ length: count }, (_, i) => ({
    playerId: `p${i + 1}`,
    coord: {
      lat: 48.8584 + (i * 0.01), // each player guesses slightly further away
      lng: 2.2945  + (i * 0.01),
    },
  }));
}

function makeCampusGuesses(count) {
  return Array.from({ length: count }, (_, i) => ({
    playerId: `p${i + 1}`,
    coord: {
      x: 0.5 + (i * 0.05),
      y: 0.5 + (i * 0.05),
    },
  }));
}

// ── scoreRound() ──────────────────────────────────────────────────────────────

describe('scoreRound()', () => {

  test('rank 1 always gets MAX_POINTS_PER_ROUND', () => {
    const guesses  = makeWorldGuesses(5);
    const allIds   = guesses.map((g) => g.playerId);
    const { scores } = scoreRound(ROUND_TYPE.WORLD, worldAnswer, guesses, allIds);
    const top = scores.find((s) => s.rank === 1);
    expect(top.points).toBe(SCORING.MAX_POINTS_PER_ROUND);
  });

  test('last rank gets MIN_POINTS_PER_ROUND', () => {
    const guesses  = makeWorldGuesses(5);
    const allIds   = guesses.map((g) => g.playerId);
    const { scores } = scoreRound(ROUND_TYPE.WORLD, worldAnswer, guesses, allIds);
    const last = scores.find((s) => s.rank === guesses.length);
    expect(last.points).toBeGreaterThanOrEqual(SCORING.MIN_POINTS_PER_ROUND);
  });

  test('scores are sorted by rank ascending', () => {
    const guesses  = makeWorldGuesses(10);
    const allIds   = guesses.map((g) => g.playerId);
    const { scores } = scoreRound(ROUND_TYPE.WORLD, worldAnswer, guesses, allIds);
    scores.forEach((s, i) => {
      expect(s.rank).toBe(i + 1);
    });
  });

  test('points decrease as rank increases', () => {
    const guesses  = makeWorldGuesses(10);
    const allIds   = guesses.map((g) => g.playerId);
    const { scores } = scoreRound(ROUND_TYPE.WORLD, worldAnswer, guesses, allIds);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i].points).toBeLessThanOrEqual(scores[i - 1].points);
    }
  });

  test('sole guesser gets MAX_POINTS_PER_ROUND', () => {
    const guesses = [{ playerId: 'p1', coord: { lat: 0, lng: 0 } }];
    const { scores } = scoreRound(ROUND_TYPE.WORLD, worldAnswer, guesses, ['p1']);
    expect(scores[0].points).toBe(SCORING.MAX_POINTS_PER_ROUND);
  });

  test('players not in guesses appear in noGuessList', () => {
    const guesses  = makeWorldGuesses(3);
    const allIds   = ['p1', 'p2', 'p3', 'p4', 'p5']; // p4 and p5 did not guess
    const { noGuessList } = scoreRound(ROUND_TYPE.WORLD, worldAnswer, guesses, allIds);
    expect(noGuessList).toContain('p4');
    expect(noGuessList).toContain('p5');
    expect(noGuessList).toHaveLength(2);
  });

  test('noGuessList is empty when all players guessed', () => {
    const guesses = makeWorldGuesses(5);
    const allIds  = guesses.map((g) => g.playerId);
    const { noGuessList } = scoreRound(ROUND_TYPE.WORLD, worldAnswer, guesses, allIds);
    expect(noGuessList).toHaveLength(0);
  });

  test('handles empty guesses array gracefully', () => {
    const allIds = ['p1', 'p2'];
    const { scores, noGuessList } = scoreRound(ROUND_TYPE.WORLD, worldAnswer, [], allIds);
    expect(scores).toHaveLength(0);
    expect(noGuessList).toHaveLength(2);
  });

  test('works correctly for campus rounds', () => {
    const guesses  = makeCampusGuesses(5);
    const allIds   = guesses.map((g) => g.playerId);
    const { scores } = scoreRound(ROUND_TYPE.CAMPUS, campusAnswer, guesses, allIds);
    expect(scores[0].points).toBe(SCORING.MAX_POINTS_PER_ROUND);
    expect(scores).toHaveLength(5);
  });

  test('all scores have required fields', () => {
    const guesses  = makeWorldGuesses(3);
    const allIds   = guesses.map((g) => g.playerId);
    const { scores } = scoreRound(ROUND_TYPE.WORLD, worldAnswer, guesses, allIds);
    scores.forEach((s) => {
      expect(s).toHaveProperty('playerId');
      expect(s).toHaveProperty('rank');
      expect(s).toHaveProperty('points');
      expect(s).toHaveProperty('distanceRaw');
      expect(s).toHaveProperty('distanceNorm');
      expect(s).toHaveProperty('distanceDisplay');
      expect(s).toHaveProperty('percentile');
    });
  });

  test('handles 100 players without performance issues', () => {
    const guesses = makeWorldGuesses(100);
    const allIds  = guesses.map((g) => g.playerId);
    const start   = Date.now();
    const { scores } = scoreRound(ROUND_TYPE.WORLD, worldAnswer, guesses, allIds);
    const elapsed = Date.now() - start;
    expect(scores).toHaveLength(100);
    expect(elapsed).toBeLessThan(500); // must complete within 500ms
  });
});

// ── buildLeaderboard() ────────────────────────────────────────────────────────

describe('buildLeaderboard()', () => {

  function makePlayers(count, scores = {}) {
    const players = new Map();
    for (let i = 1; i <= count; i++) {
      players.set(`p${i}`, {
        id:        `p${i}`,
        nickname:  `Player${i}`,
        score:     scores[`p${i}`] ?? i * 100,
        connected: true,
        role:      'player',
      });
    }
    return players;
  }

  test('leaderboard is sorted by total score descending', () => {
    const players = makePlayers(5);
    const leaderboard = buildLeaderboard(players, [], []);
    for (let i = 1; i < leaderboard.length; i++) {
      expect(leaderboard[i].totalScore).toBeLessThanOrEqual(leaderboard[i - 1].totalScore);
    }
  });

  test('position starts at 1 and is sequential', () => {
    const players = makePlayers(5);
    const leaderboard = buildLeaderboard(players, [], []);
    leaderboard.forEach((entry, i) => {
      expect(entry.position).toBe(i + 1);
    });
  });

  test('marks players who did not guess with didGuess: false', () => {
    const players     = makePlayers(3);
    const noGuessList = ['p1', 'p2'];
    const leaderboard = buildLeaderboard(players, [], noGuessList);
    const p1 = leaderboard.find((e) => e.playerId === 'p1');
    const p3 = leaderboard.find((e) => e.playerId === 'p3');
    expect(p1.didGuess).toBe(false);
    expect(p3.didGuess).toBe(true);
  });

  test('players with tied scores are sorted alphabetically by nickname', () => {
    const players = new Map([
      ['p1', { id: 'p1', nickname: 'Zara',  score: 500, connected: true, role: 'player' }],
      ['p2', { id: 'p2', nickname: 'Alice', score: 500, connected: true, role: 'player' }],
    ]);
    const leaderboard = buildLeaderboard(players, [], []);
    expect(leaderboard[0].nickname).toBe('Alice');
    expect(leaderboard[1].nickname).toBe('Zara');
  });

  test('all entries have required fields', () => {
    const players     = makePlayers(3);
    const leaderboard = buildLeaderboard(players, [], []);
    leaderboard.forEach((entry) => {
      expect(entry).toHaveProperty('playerId');
      expect(entry).toHaveProperty('nickname');
      expect(entry).toHaveProperty('totalScore');
      expect(entry).toHaveProperty('roundPoints');
      expect(entry).toHaveProperty('position');
      expect(entry).toHaveProperty('didGuess');
      expect(entry).toHaveProperty('connected');
    });
  });
});

// ── buildRevealPayload() ──────────────────────────────────────────────────────

describe('buildRevealPayload()', () => {

  test('isLastRound is true when roundIndex equals totalRounds - 1', () => {
    const payload = buildRevealPayload(worldAnswer, [], [], [], 9, 10);
    expect(payload.isLastRound).toBe(true);
  });

  test('isLastRound is false when not last round', () => {
    const payload = buildRevealPayload(worldAnswer, [], [], [], 4, 10);
    expect(payload.isLastRound).toBe(false);
  });

  test('podium contains at most 3 entries', () => {
    const leaderboard = Array.from({ length: 10 }, (_, i) => ({
      position:   i + 1,
      nickname:   `Player${i + 1}`,
      totalScore: (10 - i) * 100,
      roundPoints: 50,
    }));
    const payload = buildRevealPayload(worldAnswer, [], [], leaderboard, 0, 10);
    expect(payload.podium).toHaveLength(3);
  });

  test('podium entries are the top 3 from leaderboard', () => {
    const leaderboard = Array.from({ length: 5 }, (_, i) => ({
      position:   i + 1,
      nickname:   `Player${i + 1}`,
      totalScore: (5 - i) * 100,
      roundPoints: 50,
    }));
    const payload = buildRevealPayload(worldAnswer, [], [], leaderboard, 0, 5);
    expect(payload.podium[0].nickname).toBe('Player1');
    expect(payload.podium[1].nickname).toBe('Player2');
    expect(payload.podium[2].nickname).toBe('Player3');
  });

  test('payload includes answer coordinates', () => {
    const payload = buildRevealPayload(worldAnswer, [], [], [], 0, 5);
    expect(payload.answer).toEqual(worldAnswer);
  });
});