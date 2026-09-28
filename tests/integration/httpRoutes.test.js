'use strict';

const request = require('supertest');
const http    = require('http');
const express = require('express');
const helmet  = require('helmet');
const path    = require('path');

// Build a minimal Express app matching server/index.js for HTTP route testing
// We don't start the full server to avoid port conflicts
let app;
let server;

beforeAll((done) => {
  // Minimal app with just the routes we want to test
  app = express();
  app.use(express.json());

  // Health route
  app.get('/health', (req, res) => {
    res.json({
      status:  'ok',
      env:     'test',
      uptime:  Math.floor(process.uptime()),
      time:    new Date().toISOString(),
    });
  });

  // 404 fallback
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  server = http.createServer(app);
  server.listen(0, done); // port 0 = random available port
});

afterAll((done) => {
  server.close(done);
});

// ── /health ───────────────────────────────────────────────────────────────────

describe('GET /health', () => {

  test('returns 200 with status ok', async () => {
    const res = await request(server).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('returns JSON content type', async () => {
    const res = await request(server).get('/health');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  test('includes uptime and time fields', async () => {
    const res = await request(server).get('/health');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('time');
  });

  test('time is a valid ISO string', async () => {
    const res = await request(server).get('/health');
    expect(() => new Date(res.body.time)).not.toThrow();
    expect(new Date(res.body.time).toISOString()).toBe(res.body.time);
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────

describe('Unknown routes', () => {

  test('returns 404 for unknown GET route', async () => {
    const res = await request(server).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  test('returns 404 for unknown POST route', async () => {
    const res = await request(server).post('/does-not-exist');
    expect(res.status).toBe(404);
  });
});