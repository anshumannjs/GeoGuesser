'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const DIR  = path.join(__dirname, '..', 'results');
const FILE = path.join(DIR, 'winners.jsonl');

/**
 * Save the top 10 of a finished game. Never throws.
 * @param {{nickname: string, score: number}[]} ranked  already sorted, best first
 */
function saveTop10(ranked) {
  const top10 = ranked.slice(0, 10).map((p, i) => ({
    rank:     i + 1,
    nickname: p.nickname,
    score:    p.score,
  }));

  const entry = { finishedAt: new Date().toISOString(), top10 };

  logger.info({ top10 }, 'Final results');   // also lands in your host's logs

  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    logger.error({ err }, 'Failed to save results');
  }
}

module.exports = { saveTop10 };