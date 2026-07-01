import dotenv from 'dotenv';
dotenv.config();
import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { Server } from 'socket.io';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';
import { i18nMiddleware } from './i18n';
import logger from './logger';
import { AppError, ValidationError } from './errors';
import * as db from './db';

const PROJECT_ROOT = fs.existsSync(path.join(__dirname, 'views')) ? __dirname : path.join(__dirname, '..');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = parseInt(process.env.PORT || '3000', 10);

// --- Env validation ---
function validateEnv(): void {
  const required = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    logger.fatal({ missing }, 'Missing required env vars');
    process.exit(1);
  }
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'uac-secret-change-me') {
    logger.warn('SESSION_SECRET is insecure or default');
  }
}
validateEnv();

const ADMINS: string[] = (process.env.ADMINS || process.env.ADMIN_USERNAME || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const CLIENT_ID = process.env.DISCORD_CLIENT_ID!;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET!;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const GUILD_ID = process.env.GUILD_ID || '';

// --- Middleware ---
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(PROJECT_ROOT, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(PROJECT_ROOT, 'views'));

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

// CSRF origin check
const ALLOWED_ORIGINS = ['https://uac-game.onrender.com', 'http://localhost:3000'];
app.use((req: Request, res: Response, next: NextFunction) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  if (!origin && !referer) return next();
  if (ALLOWED_ORIGINS.some(o => origin.startsWith(o) || referer.startsWith(o))) return next();
  res.status(403).json({ error: 'Forbidden' });
});

// Request logger
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({ method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - start, userId: (req.session as any)?.user?.id });
  });
  next();
});

// --- Error handler ---
function errorHandler(err: Error, req: Request, res: Response, next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  logger.error({ err, method: req.method, url: req.originalUrl }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}

// --- Auth middleware ---
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if ((req.session as any).user) return next();
  res.redirect('/login');
}
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if ((req.session as any).user && (req.session as any).user.isAdmin) return next();
  res.status(403).send((res.locals as any).t('errors.forbidden'));
}

function sanitize(str: string): string {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>]/g, '').trim();
}

// --- Socket.io ---
io.on('connection', (socket) => {
  logger.debug({ socketId: socket.id }, 'Socket connected');
});

// --- Routes ---

app.get('/login', (req: Request, res: Response) => {
  if ((req.session as any).user) return res.redirect('/games');
  res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds`);
});

app.get('/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  if (!code) return res.redirect('/login');
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const userRes = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
    const discordUser = userRes.data as any;

    if (GUILD_ID) {
      const guildsRes = await axios.get('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
      if (!(guildsRes.data as any[]).some((g: any) => g.id === GUILD_ID)) return res.render('not-member');
    }

    const u = db.upsertUser({
      id: discordUser.id, username: discordUser.username, globalName: discordUser.global_name || discordUser.username,
      avatar: discordUser.avatar, discriminator: discordUser.discriminator,
      isAdmin: ADMINS.includes(discordUser.username.toLowerCase())
    });

    (req.session as any).user = { id: u!.id, username: u!.username, globalName: u!.globalName, avatar: u!.avatar, isAdmin: u!.isAdmin };
    logger.info({ userId: u!.id, username: u!.username }, 'User logged in');
    res.redirect('/games');
  } catch (err: any) {
    logger.error({ err: err.response?.data || err.message }, 'OAuth callback error');
    res.send((res.locals as any).t('errors.auth'));
  }
});

app.get('/logout', (req: Request, res: Response) => { (req.session as any).destroy(); res.redirect('/'); });

// --- Pages ---
app.get('/', (req: Request, res: Response) => { if ((req.session as any).user) return res.redirect('/games'); res.render('index'); });
app.get('/games', requireAuth, (req: Request, res: Response) => res.render('games', { user: (req.session as any).user }));
app.get('/game', requireAuth, (req: Request, res: Response) => res.render('game', { user: (req.session as any).user, isAdmin: (req.session as any).user.isAdmin, ADMINS }));
app.get('/admin', requireAuth, requireAdmin, (req: Request, res: Response) => res.render('admin', { user: (req.session as any).user, ADMINS }));
app.get('/admin/questions', requireAuth, requireAdmin, (req: Request, res: Response) => res.render('admin-questions', { user: (req.session as any).user, ADMINS }));
app.get('/impostor', requireAuth, (req: Request, res: Response) => res.render('impostor', { user: (req.session as any).user }));
app.get('/admin/impostor', requireAuth, requireAdmin, (req: Request, res: Response) => res.render('admin-impostor', { user: (req.session as any).user }));
app.get('/leaderboard', requireAuth, (req: Request, res: Response) => res.render('leaderboard', { user: (req.session as any).user }));

app.get('/profile', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req.session as any).user.id;
    const jpStats = db.getUserStats(userId);
    const impStats = db.getImpostorStats(userId);
    const badges: string[] = [];
    if (jpStats.wins >= 1) badges.push('first_win');
    if (jpStats.bestRank === 1) badges.push('sharp_shooter');
    if (impStats.impostorAssignments >= 1) badges.push('undercover');
    if (jpStats.wins >= 5) badges.push('champion');
    if (jpStats.wins >= 10) badges.push('legend');
    if (jpStats.totalBets >= 20) badges.push('gambler');
    if (impStats.impostorWins >= 3) badges.push('master_impostor');
    if (jpStats.top3Count >= 10) badges.push('top3_10');
    res.render('profile', { user: (req.session as any).user, stats: { ...jpStats, ...impStats, bestRank: jpStats.bestRank, top3Count: jpStats.top3Count }, badges });
  } catch (err) { next(err); }
});

// --- API ---

app.get('/api/state', (req: Request, res: Response) => {
  const round = db.getCurrentRound();
  if (!round) return res.json({ round: null, bets: [] });

  if (!round.revealed && round.deadline && Date.now() >= round.deadline) {
    db.updateRound(round.id, { revealed: 1 });
    round.revealed = true;
    io.emit('roundRevealed', { id: round.id, answer: round.answer, reason: round.reason });
  }

  const bets = (round.bets || []).map(b => round.revealed ? b : { value: b.value, reason: b.reason || null, anonymous: true });
  const userAlreadyBet = (req.session as any).user && (round.bets || []).some(b => b.userId === (req.session as any).user.id);

  res.json({
    round: {
      id: round.id, question: round.question, contextImg: round.contextImg || null,
      answer: round.revealed ? round.answer : null, reason: round.revealed ? round.reason : null,
      revealed: round.revealed, deadline: round.deadline || null, createdAt: round.createdAt
    }, bets, userAlreadyBet
  });
});

app.post('/api/bet', requireAuth, (req: Request, res: Response) => {
  const { value, reason } = req.body;
  if (value === undefined || value === null) throw new ValidationError((res.locals as any).t('errors.value_required'));
  const num = parseFloat(value);
  if (isNaN(num)) throw new ValidationError((res.locals as any).t('errors.value_invalid'));

  const round = db.getCurrentRound();
  if (!round || round.revealed) throw new ValidationError((res.locals as any).t('errors.no_round'));
  if (round.deadline && Date.now() >= round.deadline) throw new ValidationError((res.locals as any).t('errors.time_up'));
  if (round.bets.find(b => b.userId === (req.session as any).user.id)) throw new ValidationError((res.locals as any).t('errors.already_bet'));

  db.addBet(round.id, { userId: (req.session as any).user.id, username: (req.session as any).user.globalName || (req.session as any).user.username, avatar: (req.session as any).user.avatar, value: num, reason: reason ? sanitize(reason) : null, time: Date.now() });
  io.emit('betUpdate', { roundId: round.id, count: round.bets.length + 1 });
  res.json({ success: true, count: round.bets.length + 1 });
});

// --- Admin API ---

app.post('/api/admin/question', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const { question, answer, reason, contextImg, duration } = req.body;
  if (!question || answer === undefined) throw new ValidationError((res.locals as any).t('errors.question_required'));

  let deadline: number | null = null, revealed = false;
  if (duration !== 0 && duration) deadline = Date.now() + duration * 3600 * 1000;
  else revealed = true;

  const round = db.createRound({
    id: Date.now(), question: sanitize(question), answer: parseFloat(answer),
    reason: reason ? sanitize(reason) : null, contextImg: contextImg ? sanitize(contextImg) : null,
    revealed, deadline, createdBy: (req.session as any).user.username, createdAt: new Date().toISOString()
  });
  io.emit('newRound', { id: round!.id, question: round!.question, deadline: round!.deadline, revealed: round!.revealed });
  res.json({ success: true, round: { id: round!.id, question } });
});

app.post('/api/admin/reveal', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const round = db.getCurrentRound();
  if (!round) throw new ValidationError((res.locals as any).t('errors.no_round_found'));
  db.updateRound(round.id, { revealed: 1 });
  io.emit('roundRevealed', { id: round.id, answer: round.answer, reason: round.reason });
  res.json({ success: true });
});

app.get('/api/admin/history', requireAuth, requireAdmin, (req: Request, res: Response) => {
  res.json(db.getLastRoundIds(20));
});

// --- Questions bank ---

app.get('/api/admin/questions', requireAuth, requireAdmin, (req: Request, res: Response) => res.json(db.getAllQuestions()));
app.post('/api/admin/questions', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const { q, a, r } = req.body;
  if (!q || a === undefined) throw new ValidationError('Question (q) et réponse (a) requises');
  const qObj = typeof q === 'object' && q.fr ? { fr: sanitize(q.fr), en: sanitize(q.en || ''), ar: sanitize(q.ar || '') } : { fr: sanitize(q), en: '', ar: '' };
  const rObj = typeof r === 'object' ? { fr: sanitize(r.fr || ''), en: sanitize(r.en || ''), ar: sanitize(r.ar || '') } : { fr: sanitize(r || ''), en: '', ar: '' };
  db.addQuestion({ q: qObj, a: parseFloat(a), r: rObj });
  res.json({ success: true });
});
app.put('/api/admin/questions', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const { id, q, a, r } = req.body;
  if (!id || !q || a === undefined) throw new ValidationError('id, q, a requis');
  const qObj = typeof q === 'object' && q.fr ? { fr: sanitize(q.fr), en: sanitize(q.en || ''), ar: sanitize(q.ar || '') } : { fr: sanitize(q), en: '', ar: '' };
  const rObj = typeof r === 'object' ? { fr: sanitize(r.fr || ''), en: sanitize(r.en || ''), ar: sanitize(r.ar || '') } : { fr: sanitize(r || ''), en: '', ar: '' };
  db.updateQuestion(parseInt(id, 10), { q: qObj, a: parseFloat(a), r: rObj });
  res.json({ success: true });
});
app.delete('/api/admin/questions/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  db.deleteQuestion(parseInt(String(req.params.id), 10));
  res.json({ success: true });
});
app.get('/api/admin/random-question', requireAuth, requireAdmin, (req: Request, res: Response) => {
  res.json(db.getRandomQuestion((res.locals as any).lang || 'fr'));
});

// --- Leaderboard ---

app.get('/api/leaderboard', (req: Request, res: Response) => {
  res.json(db.getLeaderboard(req.query.type as string || 'global'));
});

// --- Impostor API ---

app.get('/api/impostor/state', requireAuth, (req: Request, res: Response) => {
  const round = db.getImpostorState();
  if (!round) return res.json({ round: null });
  const userId = (req.session as any).user.id;
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

app.post('/api/impostor/join', requireAuth, (req: Request, res: Response) => {
  const round = db.getImpostorState();
  if (!round || round.phase !== 'submission') return res.json({ success: true });
  if (!round.players[(req.session as any).user.id]) {
    db.upsertImpostorPlayer(round.id, {
      userId: (req.session as any).user.id, username: (req.session as any).user.globalName || (req.session as any).user.username,
      avatar: (req.session as any).user.avatar, isImpostor: false, word: '', vote: ''
    });
  }
  io.emit('impostorPlayerJoined', { count: Object.keys(db.getImpostorState()!.players).length });
  res.json({ success: true });
});

app.post('/api/impostor/submit', requireAuth, (req: Request, res: Response) => {
  const { word } = req.body;
  if (!word || !word.trim()) throw new ValidationError((res.locals as any).t('impostor.word_required'));
  const round = db.getImpostorState();
  if (!round || round.phase !== 'submission') throw new ValidationError((res.locals as any).t('impostor.not_submission_phase'));
  const player = round.players[(req.session as any).user.id];
  if (!player) throw new ValidationError((res.locals as any).t('impostor.join_first'));
  if (player.word) throw new ValidationError((res.locals as any).t('impostor.already_submitted'));
  db.upsertImpostorPlayer(round.id, { ...player, word: sanitize(word) });
  io.emit('impostorWordSubmitted', { id: round.id, playerId: (req.session as any).user.id });
  res.json({ success: true });
});

app.post('/api/impostor/vote', requireAuth, (req: Request, res: Response) => {
  const { targetId } = req.body;
  if (!targetId) throw new ValidationError((res.locals as any).t('impostor.vote_required'));
  const round = db.getImpostorState();
  if (!round || round.phase !== 'voting') throw new ValidationError((res.locals as any).t('impostor.not_voting_phase'));
  const player = round.players[(req.session as any).user.id];
  if (!player) throw new ValidationError((res.locals as any).t('impostor.join_first'));
  if (player.vote) throw new ValidationError((res.locals as any).t('impostor.already_voted'));
  if (!round.players[targetId]) throw new ValidationError((res.locals as any).t('impostor.invalid_target'));
  if (targetId === (req.session as any).user.id) throw new ValidationError((res.locals as any).t('impostor.cannot_self_vote'));
  db.upsertImpostorPlayer(round.id, { ...player, vote: targetId });
  io.emit('impostorVoteCast', { id: round.id, playerId: (req.session as any).user.id });
  res.json({ success: true });
});

// --- Admin Impostor API ---

app.get('/api/admin/impostor-words', requireAuth, requireAdmin, (req: Request, res: Response) => res.json(db.getAllWords()));
app.get('/api/admin/impostor/history', requireAuth, requireAdmin, (req: Request, res: Response) => res.json(db.getLastImpostorRoundIds(10)));

app.post('/api/admin/impostor/start', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const { realWord, fakeWord } = req.body;
  if (!realWord || !fakeWord) throw new ValidationError((res.locals as any).t('impostor.words_required'));
  db.createImpostorRound({
    id: Date.now(), realWord: sanitize(realWord), fakeWord: sanitize(fakeWord),
    createdBy: (req.session as any).user.username, createdAt: new Date().toISOString()
  });
  io.emit('impostorStart', { id: Date.now() });
  res.json({ success: true });
});

app.post('/api/admin/impostor/start-random', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const lang = (res.locals as any).lang || 'fr';
  const pair = db.getRandomWord(lang);
  if (!pair) throw new ValidationError((res.locals as any).t('impostor.no_words'));
  db.createImpostorRound({
    id: Date.now(), realWord: pair.real, fakeWord: pair.fake,
    createdBy: (req.session as any).user.username, createdAt: new Date().toISOString()
  });
  io.emit('impostorStart', { id: Date.now() });
  res.json({ success: true, realWord: pair.real, fakeWord: pair.fake });
});

app.post('/api/admin/impostor/assign', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const { targetId } = req.body;
  const round = db.getImpostorState();
  if (!round || round.phase !== 'submission') throw new ValidationError((res.locals as any).t('impostor.no_round'));
  const playerIds = Object.keys(round.players);
  if (playerIds.length < 2) throw new ValidationError((res.locals as any).t('impostor.need_players'));

  for (const pid of playerIds) db.upsertImpostorPlayer(round.id, { ...round.players[pid], isImpostor: false });
  const impostorId = targetId || playerIds[Math.floor(Math.random() * playerIds.length)];
  db.upsertImpostorPlayer(round.id, { ...round.players[impostorId], isImpostor: true });
  db.updateImpostorRound(round.id, { impostorId });
  io.emit('impostorAssign', { id: round.id });
  res.json({ success: true, impostorId });
});

app.post('/api/admin/impostor/voting-phase', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const round = db.getImpostorState();
  if (!round || round.phase !== 'submission') throw new ValidationError((res.locals as any).t('impostor.no_round'));
  db.updateImpostorRound(round.id, { phase: 'voting' });
  io.emit('impostorVoting', { id: round.id });
  res.json({ success: true });
});

app.post('/api/admin/impostor/reveal', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const round = db.getImpostorState();
  if (!round || round.phase !== 'voting') throw new ValidationError((res.locals as any).t('impostor.no_round'));
  const impostorId = round.impostorId;
  const votes: Record<string, number> = {};
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

// --- Error handler (last) ---
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
function shutdown(signal: string): void {
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
async function main(): Promise<void> {
  await db.init();
  server.listen(PORT, () => {
    logger.info({ port: PORT, admins: ADMINS }, 'UAC Game server started');
  });
}

if (require.main === module) {
  main();
} else {
  module.exports = app;
  const ready = db.init();
  (module.exports as any)._ready = ready;
}
