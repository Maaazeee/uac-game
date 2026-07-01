require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { i18nMiddleware } = require('./i18n');
const logger = require('./logger');
const { AppError, ValidationError, ForbiddenError } = require('./errors');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// --- Env validation ---
function validateEnv() {
  const required = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    logger.fatal({ missing }, 'Missing required env vars');
    process.exit(1);
  }
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'uac-secret-change-me') {
    logger.warn('SESSION_SECRET is insecure or default — set a strong secret in production');
  }
}
validateEnv();

const ADMINS = (process.env.ADMINS || process.env.ADMIN_USERNAME || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const GUILD_ID = process.env.GUILD_ID || '';

// --- Middleware ---
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'uac-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(i18nMiddleware);

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' } });
app.use('/api/', apiLimiter);

// CSRF origin check — only block if a mismatched header is present
const ALLOWED_ORIGINS = ['https://uac-game.onrender.com', 'http://localhost:3000'];
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  if (!origin && !referer) return next(); // no header to check (curl, tests, server-to-server)
  if (ALLOWED_ORIGINS.some(o => origin.startsWith(o) || referer.startsWith(o))) return next();
  res.status(403).json({ error: 'Forbidden' });
});

// --- Request logger ---
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({ method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - start, userId: req.session?.user?.id });
  });
  next();
});

// --- Error handler ---
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  logger.error({ err, method: req.method, url: req.originalUrl }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}
function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.isAdmin) return next();
  res.status(403).send(res.locals.t('errors.forbidden'));
}

function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>]/g, '').trim();
}

// --- Socket.io ---
io.on('connection', (socket) => {
  logger.debug({ socketId: socket.id }, 'Socket connected');
});

// --- Routes ---

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/games');
  res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds`);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/login');
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const userRes = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
    const discordUser = userRes.data;

    if (GUILD_ID) {
      const guildsRes = await axios.get('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
      if (!guildsRes.data.some(g => g.id === GUILD_ID)) return res.render('not-member');
    }

    const u = await db.upsertUser({
      id: discordUser.id, username: discordUser.username, globalName: discordUser.global_name || discordUser.username,
      avatar: discordUser.avatar, discriminator: discordUser.discriminator,
      isAdmin: ADMINS.includes(discordUser.username.toLowerCase())
    });

    req.session.user = { id: u.id, username: u.username, globalName: u.globalName, avatar: u.avatar, isAdmin: u.isAdmin };
    logger.info({ userId: u.id, username: u.username }, 'User logged in');
    res.redirect('/games');
  } catch (err) {
    logger.error({ err }, 'OAuth callback error');
    res.send(res.locals.t('errors.auth'));
  }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// --- Pages ---
app.get('/', (req, res) => { if (req.session.user) return res.redirect('/games'); res.render('index'); });
app.get('/games', requireAuth, (req, res) => res.render('games', { user: req.session.user }));
app.get('/game', requireAuth, (req, res) => res.render('game', { user: req.session.user, isAdmin: req.session.user.isAdmin, ADMINS }));
app.get('/admin', requireAuth, requireAdmin, (req, res) => res.render('admin', { user: req.session.user, ADMINS }));
app.get('/admin/questions', requireAuth, requireAdmin, (req, res) => res.render('admin-questions', { user: req.session.user, ADMINS }));
app.get('/impostor', requireAuth, (req, res) => res.render('impostor', { user: req.session.user }));
app.get('/admin/impostor', requireAuth, requireAdmin, (req, res) => res.render('admin-impostor', { user: req.session.user }));
app.get('/leaderboard', requireAuth, (req, res) => res.render('leaderboard', { user: req.session.user }));

app.get('/profile', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [jpStats, impStats] = await Promise.all([db.getUserStats(userId), db.getImpostorStats(userId)]);
    const badges = [];
    if (jpStats.wins >= 1) badges.push('first_win');
    if (jpStats.bestRank === 1) badges.push('sharp_shooter');
    if (impStats.impostorAssignments >= 1) badges.push('undercover');
    if (jpStats.wins >= 5) badges.push('champion');
    if (jpStats.wins >= 10) badges.push('legend');
    if (jpStats.totalBets >= 20) badges.push('gambler');
    if (impStats.impostorWins >= 3) badges.push('master_impostor');
    if (jpStats.top3Count >= 10) badges.push('top3_10');
    res.render('profile', { user: req.session.user, stats: { ...jpStats, ...impStats }, badges });
  } catch (err) { next(err); }
});

// --- API ---

app.get('/api/state', (req, res) => {
  const round = db.getCurrentRound();
  if (!round) return res.json({ round: null, bets: [] });

  if (!round.revealed && round.deadline && Date.now() >= round.deadline) {
    db.updateRound(round.id, { revealed: 1 });
    round.revealed = true;
    io.emit('roundRevealed', { id: round.id, answer: round.answer, reason: round.reason });
  }

  const bets = (round.bets || []).map(b => round.revealed ? b : { value: b.value, reason: b.reason || null, anonymous: true });
  const userAlreadyBet = req.session.user && (round.bets || []).some(b => b.userId === req.session.user.id);

  res.json({
    round: {
      id: round.id, question: round.question, contextImg: round.contextImg || null,
      answer: round.revealed ? round.answer : null, reason: round.revealed ? round.reason : null,
      revealed: round.revealed, deadline: round.deadline || null, createdAt: round.createdAt
    }, bets, userAlreadyBet
  });
});

app.post('/api/bet', requireAuth, (req, res) => {
  const { value, reason } = req.body;
  if (value === undefined || value === null) throw new ValidationError(res.locals.t('errors.value_required'));
  const num = parseFloat(value);
  if (isNaN(num)) throw new ValidationError(res.locals.t('errors.value_invalid'));

  const round = db.getCurrentRound();
  if (!round || round.revealed) throw new ValidationError(res.locals.t('errors.no_round'));
  if (round.deadline && Date.now() >= round.deadline) throw new ValidationError(res.locals.t('errors.time_up'));
  if (round.bets.find(b => b.userId === req.session.user.id)) throw new ValidationError(res.locals.t('errors.already_bet'));

  db.addBet(round.id, { userId: req.session.user.id, username: req.session.user.globalName || req.session.user.username, avatar: req.session.user.avatar, value: num, reason: reason ? sanitize(reason) : null, time: Date.now() });
  io.emit('betUpdate', { roundId: round.id, count: (round.bets.length + 1) });
  res.json({ success: true, count: round.bets.length + 1 });
});

// --- Admin API ---

app.post('/api/admin/question', requireAuth, requireAdmin, (req, res) => {
  const { question, answer, reason, contextImg, duration } = req.body;
  if (!question || answer === undefined) throw new ValidationError(res.locals.t('errors.question_required'));

  let deadline = null, revealed = false;
  if (duration !== 0 && duration) deadline = Date.now() + duration * 3600 * 1000;
  else revealed = true;

  const round = db.createRound({
    id: Date.now(), question: sanitize(question), answer: parseFloat(answer),
    reason: reason ? sanitize(reason) : null, contextImg: contextImg ? sanitize(contextImg) : null,
    revealed, deadline, createdBy: req.session.user.username, createdAt: new Date().toISOString()
  });
  io.emit('newRound', { id: round.id, question: round.question, deadline: round.deadline, revealed: round.revealed });
  res.json({ success: true, round: { id: round.id, question } });
});

app.post('/api/admin/reveal', requireAuth, requireAdmin, (req, res) => {
  const round = db.getCurrentRound();
  if (!round) throw new ValidationError(res.locals.t('errors.no_round_found'));
  db.updateRound(round.id, { revealed: 1 });
  io.emit('roundRevealed', { id: round.id, answer: round.answer, reason: round.reason });
  res.json({ success: true });
});

app.get('/api/admin/history', requireAuth, requireAdmin, (req, res) => {
  res.json(db.getLastRoundIds(20));
});

// --- Questions bank ---

app.get('/api/admin/questions', requireAuth, requireAdmin, (req, res) => res.json(db.getAllQuestions()));
app.post('/api/admin/questions', requireAuth, requireAdmin, (req, res) => {
  const { q, a, r } = req.body;
  if (!q || a === undefined) throw new ValidationError('Question (q) et réponse (a) requises');
  const qObj = typeof q === 'object' && q.fr ? { fr: sanitize(q.fr), en: sanitize(q.en || ''), ar: sanitize(q.ar || '') } : { fr: sanitize(q), en: '', ar: '' };
  const rObj = typeof r === 'object' ? { fr: sanitize(r.fr || ''), en: sanitize(r.en || ''), ar: sanitize(r.ar || '') } : { fr: sanitize(r || ''), en: '', ar: '' };
  db.addQuestion({ q: qObj, a: parseFloat(a), r: rObj });
  res.json({ success: true });
});
app.put('/api/admin/questions', requireAuth, requireAdmin, (req, res) => {
  const { id, q, a, r } = req.body;
  if (!id || !q || a === undefined) throw new ValidationError('id, q, a requis');
  const qObj = typeof q === 'object' && q.fr ? { fr: sanitize(q.fr), en: sanitize(q.en || ''), ar: sanitize(q.ar || '') } : { fr: sanitize(q), en: '', ar: '' };
  const rObj = typeof r === 'object' ? { fr: sanitize(r.fr || ''), en: sanitize(r.en || ''), ar: sanitize(r.ar || '') } : { fr: sanitize(r || ''), en: '', ar: '' };
  db.updateQuestion(parseInt(id), { q: qObj, a: parseFloat(a), r: rObj });
  res.json({ success: true });
});
app.delete('/api/admin/questions/:id', requireAuth, requireAdmin, (req, res) => {
  db.deleteQuestion(parseInt(req.params.id));
  res.json({ success: true });
});
app.get('/api/admin/random-question', requireAuth, requireAdmin, (req, res) => {
  res.json(db.getRandomQuestion(res.locals.lang || 'fr'));
});

// --- Leaderboard ---

app.get('/api/leaderboard', (req, res) => {
  const type = req.query.type || 'global';
  res.json(db.getLeaderboard(type));
});

// --- Impostor API ---

app.get('/api/impostor/state', requireAuth, (req, res) => {
  const round = db.getImpostorState();
  if (!round) return res.json({ round: null });
  const userId = req.session.user.id;
  const player = round.players[userId];
  res.json({
    round: {
      id: round.id, phase: round.phase,
      realWord: round.phase === 'submission' && player ? (player.isImpostor ? round.fakeWord : round.realWord) : null,
      players: Object.keys(round.players), playerCount: Object.keys(round.players).length,
      submissions: round.phase === 'voting' || round.phase === 'revealed'
        ? Object.values(round.players).map(p => ({ word: p.word, userId: p.userId })) : null,
      impostorId: round.phase === 'revealed' ? round.impostorId : null,
      winner: round.phase === 'revealed' ? round.winner : null,
      votes: round.phase === 'revealed' ? round.votes : null, createdAt: round.createdAt
    },
    iAmImpostor: player ? player.isImpostor : false,
    iSubmitted: player ? !!player.word : false,
    iVoted: player ? !!player.vote : false
  });
});

app.post('/api/impostor/join', requireAuth, (req, res) => {
  const round = db.getImpostorState();
  if (!round || round.phase !== 'submission') return res.json({ success: true });
  if (!round.players[req.session.user.id]) {
    db.upsertImpostorPlayer(round.id, {
      userId: req.session.user.id, username: req.session.user.globalName || req.session.user.username,
      avatar: req.session.user.avatar, isImpostor: false, word: '', vote: ''
    });
  }
  io.emit('impostorPlayerJoined', { count: Object.keys(db.getImpostorState().players).length });
  res.json({ success: true });
});

app.post('/api/impostor/submit', requireAuth, (req, res) => {
  const { word } = req.body;
  if (!word || !word.trim()) throw new ValidationError(res.locals.t('impostor.word_required'));
  const round = db.getImpostorState();
  if (!round || round.phase !== 'submission') throw new ValidationError(res.locals.t('impostor.not_submission_phase'));
  const player = round.players[req.session.user.id];
  if (!player) throw new ValidationError(res.locals.t('impostor.join_first'));
  if (player.word) throw new ValidationError(res.locals.t('impostor.already_submitted'));
  db.upsertImpostorPlayer(round.id, { ...player, word: sanitize(word) });
  io.emit('impostorWordSubmitted', { id: round.id, playerId: req.session.user.id });
  res.json({ success: true });
});

app.post('/api/impostor/vote', requireAuth, (req, res) => {
  const { targetId } = req.body;
  if (!targetId) throw new ValidationError(res.locals.t('impostor.vote_required'));
  const round = db.getImpostorState();
  if (!round || round.phase !== 'voting') throw new ValidationError(res.locals.t('impostor.not_voting_phase'));
  const player = round.players[req.session.user.id];
  if (!player) throw new ValidationError(res.locals.t('impostor.join_first'));
  if (player.vote) throw new ValidationError(res.locals.t('impostor.already_voted'));
  if (!round.players[targetId]) throw new ValidationError(res.locals.t('impostor.invalid_target'));
  if (targetId === req.session.user.id) throw new ValidationError(res.locals.t('impostor.cannot_self_vote'));
  db.upsertImpostorPlayer(round.id, { ...player, vote: targetId });
  io.emit('impostorVoteCast', { id: round.id, playerId: req.session.user.id });
  res.json({ success: true });
});

// --- Admin Impostor API ---

app.get('/api/admin/impostor-words', requireAuth, requireAdmin, (req, res) => res.json(db.getAllWords()));
app.get('/api/admin/impostor/history', requireAuth, requireAdmin, (req, res) => res.json(db.getLastImpostorRoundIds(10)));

app.post('/api/admin/impostor/start', requireAuth, requireAdmin, (req, res) => {
  const { realWord, fakeWord } = req.body;
  if (!realWord || !fakeWord) throw new ValidationError(res.locals.t('impostor.words_required'));
  db.createImpostorRound({
    id: Date.now(), realWord: sanitize(realWord), fakeWord: sanitize(fakeWord),
    createdBy: req.session.user.username, createdAt: new Date().toISOString()
  });
  io.emit('impostorStart', { id: Date.now() });
  res.json({ success: true });
});

app.post('/api/admin/impostor/start-random', requireAuth, requireAdmin, (req, res) => {
  const lang = res.locals.lang || 'fr';
  const pair = db.getRandomWord(lang);
  if (!pair) throw new ValidationError(res.locals.t('impostor.no_words'));
  db.createImpostorRound({
    id: Date.now(), realWord: pair.real, fakeWord: pair.fake,
    createdBy: req.session.user.username, createdAt: new Date().toISOString()
  });
  io.emit('impostorStart', { id: Date.now() });
  res.json({ success: true, realWord: pair.real, fakeWord: pair.fake });
});

app.post('/api/admin/impostor/assign', requireAuth, requireAdmin, (req, res) => {
  const { targetId } = req.body;
  const round = db.getImpostorState();
  if (!round || round.phase !== 'submission') throw new ValidationError(res.locals.t('impostor.no_round'));
  const playerIds = Object.keys(round.players);
  if (playerIds.length < 2) throw new ValidationError(res.locals.t('impostor.need_players'));

  // Reset impostor status for all players
  for (const pid of playerIds) {
    db.upsertImpostorPlayer(round.id, { ...round.players[pid], isImpostor: false });
  }
  const impostorId = targetId || playerIds[Math.floor(Math.random() * playerIds.length)];
  db.upsertImpostorPlayer(round.id, { ...round.players[impostorId], isImpostor: true });
  db.updateImpostorRound(round.id, { impostorId });
  io.emit('impostorAssign', { id: round.id });
  res.json({ success: true, impostorId });
});

app.post('/api/admin/impostor/voting-phase', requireAuth, requireAdmin, (req, res) => {
  const round = db.getImpostorState();
  if (!round || round.phase !== 'submission') throw new ValidationError(res.locals.t('impostor.no_round'));
  db.updateImpostorRound(round.id, { phase: 'voting' });
  io.emit('impostorVoting', { id: round.id });
  res.json({ success: true });
});

app.post('/api/admin/impostor/reveal', requireAuth, requireAdmin, (req, res) => {
  const round = db.getImpostorState();
  if (!round || round.phase !== 'voting') throw new ValidationError(res.locals.t('impostor.no_round'));
  const impostorId = round.impostorId;
  const votes = {};
  Object.values(round.players).forEach(p => { if (p.vote) votes[p.vote] = (votes[p.vote] || 0) + 1; });
  const impostorVotes = votes[impostorId] || 0;
  const totalVoters = Object.values(round.players).filter(p => p.vote).length;
  const majority = totalVoters > 0 && impostorVotes > totalVoters / 2;
  const winner = majority ? 'players' : 'impostor';

  db.updateImpostorRound(round.id, { phase: 'revealed', winner });
  for (const pid of Object.keys(round.players)) {
    const pts = winner === 'impostor' && pid === impostorId ? 3 : (winner === 'players' && pid !== impostorId ? 1 : 0);
    if (pts) db.addImpostorPoints(round.id, pid, pts);
  }
  io.emit('impostorRevealed', { id: round.id, winner });
  res.json({ success: true, winner });
});

// --- Error handler (must be last) ---
app.use(errorHandler);

// --- Cron: auto-reveal every 10s ---
cron.schedule('*/10 * * * * *', () => {
  const round = db.getCurrentRound();
  if (round && !round.revealed && round.deadline && Date.now() >= round.deadline) {
    db.updateRound(round.id, { revealed: 1 });
    io.emit('roundRevealed', { id: round.id, answer: round.answer, reason: round.reason });
    logger.info({ roundId: round.id }, 'Auto-revealed round via cron');
  }
});

// --- Graceful shutdown ---
async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down gracefully');
  io.close(() => logger.info('Socket.io closed'));
  server.close(() => {
    db.save();
    logger.info('Server closed');
    process.exit(0);
  });
  setTimeout(() => { logger.error('Forced shutdown after timeout'); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Start ---
async function main() {
  await db.init();
  server.listen(PORT, () => {
    logger.info({ port: PORT, admins: ADMINS }, 'UAC Game server started');
    if (!CLIENT_ID) logger.warn('DISCORD_CLIENT_ID not set');
  });
}

if (require.main === module) {
  main();
} else {
  // Used by tests — ensure DB is inited before app is used
  module.exports = app;
  let ready = db.init();
  module.exports._ready = ready;
}
