const { expect } = require('chai');
const request = require('supertest');
const path = require('path');
const fs = require('fs');

process.env.SESSION_SECRET = 'test-secret';
process.env.DISCORD_CLIENT_ID = 'test-id';
process.env.DISCORD_CLIENT_SECRET = 'test-secret';
process.env.PORT = '0';

const TEST_DB = path.join(__dirname, '..', 'data', 'database.sqlite');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

const app = require('../server');

describe('API', function () {
  before(async function () {
    await app._ready;
  });

  it('GET / returns homepage', async function () {
    const res = await request(app).get('/');
    expect(res.status).to.equal(200);
    expect(res.text).to.contain('UAC');
  });

  it('GET /api/state returns current state', async function () {
    const res = await request(app).get('/api/state');
    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('round');
    expect(res.body).to.have.property('bets');
  });

  it('GET /api/leaderboard returns array', async function () {
    const res = await request(app).get('/api/leaderboard');
    expect(res.status).to.equal(200);
    expect(res.body).to.be.an('array');
  });

  it('GET /api/leaderboard?type=global works', async function () {
    const res = await request(app).get('/api/leaderboard?type=global');
    expect(res.status).to.equal(200);
  });

  it('GET /api/leaderboard?type=justeprix works', async function () {
    const res = await request(app).get('/api/leaderboard?type=justeprix');
    expect(res.status).to.equal(200);
  });

  it('GET /api/leaderboard?type=impostor works', async function () {
    const res = await request(app).get('/api/leaderboard?type=impostor');
    expect(res.status).to.equal(200);
  });

  it('POST /api/bet without auth returns 302 redirect', async function () {
    const res = await request(app).post('/api/bet').send({ value: 50 });
    expect(res.status).to.equal(302);
  });

  it('GET /game without auth redirects to login', async function () {
    const res = await request(app).get('/game');
    expect(res.status).to.equal(302);
  });

  it('GET /admin without auth redirects to login', async function () {
    const res = await request(app).get('/admin');
    expect(res.status).to.equal(302);
  });
});
