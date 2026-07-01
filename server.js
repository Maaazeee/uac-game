require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { i18nMiddleware } = require('./i18n');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Database JSON ---
const DB_PATH = path.join(__dirname, 'data', 'db.json');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { users: [], rounds: [] }; }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Init DB
if (!fs.existsSync(DB_PATH)) saveDB(loadDB());

// --- Config ---
const ADMINS = (process.env.ADMINS || process.env.ADMIN_USERNAME || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const GUILD_ID = process.env.GUILD_ID || '';

// --- Middleware ---
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
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(i18nMiddleware);

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.isAdmin) return next();
  res.status(403).send(res.locals.t('errors.forbidden'));
}

// --- Routes ---

// Login - redirect to Discord
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/games');
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
  res.redirect(url);
});

// Discord callback
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/login');

  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });

    const discordUser = userRes.data;

    // Check guild membership
    if (GUILD_ID) {
      const guildsRes = await axios.get('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
      });
      const memberOfGuild = guildsRes.data.some(g => g.id === GUILD_ID);
      if (!memberOfGuild) {
        return res.render('not-member');
      }
    }

    const db = loadDB();
    let user = db.users.find(u => u.id === discordUser.id);

    if (!user) {
      user = {
        id: discordUser.id,
        username: discordUser.username,
        globalName: discordUser.global_name || discordUser.username,
        avatar: discordUser.avatar,
        discriminator: discordUser.discriminator,
        isAdmin: ADMINS.includes(discordUser.username.toLowerCase()),
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
      saveDB(db);
    } else {
      // Update admin status
      user.isAdmin = ADMINS.includes(discordUser.username.toLowerCase());
      user.username = discordUser.username;
      user.globalName = discordUser.global_name || discordUser.username;
      user.avatar = discordUser.avatar;
      saveDB(db);
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      globalName: user.globalName,
      avatar: user.avatar,
      isAdmin: user.isAdmin
    };

    res.redirect('/games');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.send(res.locals.t('errors.auth'));
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// --- Pages ---

// Game page (player)
app.get('/game', requireAuth, (req, res) => {
  res.render('game', {
    user: req.session.user,
    isAdmin: req.session.user.isAdmin,
    ADMINS
  });
});

// Admin page
app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  res.render('admin', {
    user: req.session.user,
    ADMINS
  });
});

// Homepage
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/games');
  res.render('index');
});

// Question bank management page
app.get('/admin/questions', requireAuth, requireAdmin, (req, res) => {
  res.render('admin-questions', { user: req.session.user, ADMINS });
});

// Games hub
app.get('/games', requireAuth, (req, res) => {
  res.render('games', { user: req.session.user });
});

// --- API ---

// Auto-reveal helper: check deadline
function autoReveal(round) {
  if (!round.revealed && round.deadline && Date.now() >= round.deadline) {
    round.revealed = true;
    return true;
  }
  return false;
}

// Leaderboard calculation
function computeLeaderboard(rounds) {
  const scores = {};
  for (const r of rounds) {
    if (!r.revealed || !r.bets || r.bets.length === 0) continue;
    const sorted = [...r.bets].sort((a, b) => {
      const da = Math.abs(a.value - r.answer);
      const db = Math.abs(b.value - r.answer);
      if (da !== db) return da - db;
      if (a.value <= r.answer && b.value > r.answer) return -1;
      if (a.value > r.answer && b.value <= r.answer) return 1;
      return 0;
    });
    sorted.forEach((b, i) => {
      if (!scores[b.userId]) {
        scores[b.userId] = { userId: b.userId, username: b.username, avatar: b.avatar, points: 0, wins: 0, bets: 0 };
      }
      scores[b.userId].bets++;
      if (i === 0) { scores[b.userId].points += 3; scores[b.userId].wins++; }
      else if (i === 1) scores[b.userId].points += 2;
      else if (i === 2) scores[b.userId].points += 1;
    });
  }
  return Object.values(scores).sort((a, b) => b.points - a.points || b.wins - a.wins);
}

// Get current game state
app.get('/api/state', (req, res) => {
  const db = loadDB();
  const currentRound = db.rounds[db.rounds.length - 1] || null;
  if (!currentRound) return res.json({ round: null, bets: [] });

  // Auto-reveal if deadline passed
  if (autoReveal(currentRound)) saveDB(db);

  const bets = (currentRound.bets || []).map(b => {
    const isRevealed = currentRound.revealed;
    if (isRevealed) return b;
    return { value: b.value, reason: b.reason || null, anonymous: true };
  });

  const userAlreadyBet = req.session.user && (currentRound.bets || []).some(b => b.userId === req.session.user.id);

  res.json({
    round: {
      id: currentRound.id,
      question: currentRound.question,
      contextImg: currentRound.contextImg || null,
      answer: currentRound.revealed ? currentRound.answer : null,
      reason: currentRound.revealed ? currentRound.reason : null,
      revealed: currentRound.revealed,
      deadline: currentRound.deadline || null,
      createdAt: currentRound.createdAt
    },
    bets,
    userAlreadyBet
  });
});

// Submit bet
app.post('/api/bet', requireAuth, (req, res) => {
  const { value, reason } = req.body;
  if (value === undefined || value === null) return res.status(400).json({ error: res.locals.t('errors.value_required') });
  const num = parseFloat(value);
  if (isNaN(num)) return res.status(400).json({ error: res.locals.t('errors.value_invalid') });

  const db = loadDB();
  const round = db.rounds[db.rounds.length - 1];
  if (!round || round.revealed) return res.status(400).json({ error: res.locals.t('errors.no_round') });
  if (round.deadline && Date.now() >= round.deadline) return res.status(400).json({ error: res.locals.t('errors.time_up') });

  // Check if user already bet
  if (round.bets.find(b => b.userId === req.session.user.id)) {
    return res.status(400).json({ error: res.locals.t('errors.already_bet') });
  }

  round.bets.push({
    userId: req.session.user.id,
    username: req.session.user.globalName || req.session.user.username,
    avatar: req.session.user.avatar,
    value: num,
    reason: reason || null,
    time: Date.now()
  });

  saveDB(db);
  res.json({ success: true, count: round.bets.length });
});

// --- Admin API ---

// Set new round
app.post('/api/admin/question', requireAuth, requireAdmin, (req, res) => {
  const { question, answer, reason, contextImg, duration } = req.body;
  if (!question || answer === undefined) return res.status(400).json({ error: res.locals.t('errors.question_required') });

  const db = loadDB();
  let deadline = null;
  let revealed = false;
  if (duration === 0 || !duration) {
    revealed = true; // Instant reveal
  } else {
    deadline = Date.now() + duration * 3600 * 1000; // duration in hours
  }

  const round = {
    id: Date.now(),
    question,
    answer: parseFloat(answer),
    reason: reason || null,
    contextImg: contextImg || null,
    revealed,
    deadline,
    bets: [],
    createdBy: req.session.user.username,
    createdAt: new Date().toISOString()
  };
  db.rounds.push(round);
  saveDB(db);

  res.json({ success: true, round: { id: round.id, question } });
});

// Reveal answers
app.post('/api/admin/reveal', requireAuth, requireAdmin, (req, res) => {
  const db = loadDB();
  const round = db.rounds[db.rounds.length - 1];
  if (!round) return res.status(400).json({ error: res.locals.t('errors.no_round_found') });

  round.revealed = true;
  saveDB(db);
  res.json({ success: true });
});

// Get all rounds (admin)
app.get('/api/admin/history', requireAuth, requireAdmin, (req, res) => {
  const db = loadDB();
  res.json(db.rounds.slice(-20).reverse());
});

// --- Question Bank Management ---

const QUESTIONS_PATH = path.join(__dirname, 'questions.json');

function loadQuestions() {
  try { return JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8')); }
  catch { return []; }
}

function saveQuestions(questions) {
  fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(questions, null, 2));
}

// Get all questions
app.get('/api/admin/questions', requireAuth, requireAdmin, (req, res) => {
  res.json(loadQuestions());
});

// Add a question
app.post('/api/admin/questions', requireAuth, requireAdmin, (req, res) => {
  const { q, a, r } = req.body;
  if (!q || a === undefined) return res.status(400).json({ error: 'Question (q) et réponse (a) requises' });
  const question = typeof q === 'object' && q.fr
    ? { q: { fr: q.fr.trim(), en: (q.en || '').trim(), ar: (q.ar || '').trim() }, a: parseFloat(a), r: typeof r === 'object' ? { fr: (r.fr || '').trim(), en: (r.en || '').trim(), ar: (r.ar || '').trim() } : { fr: (r || '').trim(), en: '', ar: '' } }
    : { q: q.trim(), a: parseFloat(a), r: (r || '').trim() };
  const questions = loadQuestions();
  questions.push(question);
  saveQuestions(questions);
  res.json({ success: true, index: questions.length - 1 });
});

// Update a question
app.put('/api/admin/questions/:index', requireAuth, requireAdmin, (req, res) => {
  const { q, a, r } = req.body;
  const index = parseInt(req.params.index);
  const questions = loadQuestions();
  if (index < 0 || index >= questions.length) return res.status(404).json({ error: 'Question introuvable' });
  if (!q || a === undefined) return res.status(400).json({ error: 'Question (q) et réponse (a) requises' });
  questions[index] = typeof q === 'object' && q.fr
    ? { q: { fr: q.fr.trim(), en: (q.en || '').trim(), ar: (q.ar || '').trim() }, a: parseFloat(a), r: typeof r === 'object' ? { fr: (r.fr || '').trim(), en: (r.en || '').trim(), ar: (r.ar || '').trim() } : { fr: (r || '').trim(), en: '', ar: '' } }
    : { q: q.trim(), a: parseFloat(a), r: (r || '').trim() };
  saveQuestions(questions);
  res.json({ success: true });
});

// Delete a question
app.delete('/api/admin/questions/:index', requireAuth, requireAdmin, (req, res) => {
  const index = parseInt(req.params.index);
  const questions = loadQuestions();
  if (index < 0 || index >= questions.length) return res.status(404).json({ error: 'Question introuvable' });
  questions.splice(index, 1);
  saveQuestions(questions);
  res.json({ success: true });
});

// Get random funny question (localized)
app.get('/api/admin/random-question', requireAuth, requireAdmin, (req, res) => {
  try {
    const questions = loadQuestions();
    if (questions.length === 0) return res.json({ q: '', a: 0, r: '' });
    const q = questions[Math.floor(Math.random() * questions.length)];
    const lang = res.locals.lang || 'fr';
    const localized = {
      q: typeof q.q === 'object' ? (q.q[lang] || q.q.fr) : q.q,
      a: q.a,
      r: typeof q.r === 'object' ? (q.r[lang] || q.r.fr) : (q.r || '')
    };
    res.json(localized);
  } catch { res.json({ q: '', a: 0, r: '' }); }
});

// --- Leaderboard ---

app.get('/leaderboard', requireAuth, (req, res) => {
  res.render('leaderboard', { user: req.session.user });
});

app.get('/api/leaderboard', (req, res) => {
  const db = loadDB();
  res.json(computeLeaderboard(db.rounds));
});

// --- Impostor Game ---

const IMPOSTOR_WORDS_PATH = path.join(__dirname, 'impostor-words.json');

function loadImpostorWords() {
  try { return JSON.parse(fs.readFileSync(IMPOSTOR_WORDS_PATH, 'utf8')); }
  catch { return []; }
}

function getImpostorState(db) {
  const rounds = db.impostorRounds || [];
  return rounds[rounds.length - 1] || null;
}

function saveImpostorState(db, round) {
  if (!db.impostorRounds) db.impostorRounds = [];
  if (round) {
    if (db.impostorRounds.length === 0 || db.impostorRounds[db.impostorRounds.length - 1].id !== round.id) {
      db.impostorRounds.push(round);
    } else {
      db.impostorRounds[db.impostorRounds.length - 1] = round;
    }
  }
  saveDB(db);
}

// Impostor game page
app.get('/impostor', requireAuth, (req, res) => {
  res.render('impostor', { user: req.session.user });
});

// Admin impostor page
app.get('/admin/impostor', requireAuth, requireAdmin, (req, res) => {
  res.render('admin-impostor', { user: req.session.user });
});

// Get active impostor round + current player info
app.get('/api/impostor/state', requireAuth, (req, res) => {
  const db = loadDB();
  const round = getImpostorState(db);
  if (!round) return res.json({ round: null });

  const userId = req.session.user.id;
  const player = round.players[userId];

  res.json({
    round: {
      id: round.id,
      phase: round.phase,
      realWord: round.phase === 'submission' && player
        ? (player.isImpostor ? round.fakeWord : round.realWord)
        : null,
      players: Object.keys(round.players),
      playerCount: Object.keys(round.players).length,
      submissions: round.phase === 'voting' || round.phase === 'revealed'
        ? Object.values(round.players).map(p => ({ word: p.word, userId: p.userId }))
        : null,
      impostorId: round.phase === 'revealed' ? round.impostorId : null,
      winner: round.phase === 'revealed' ? round.winner : null,
      votes: round.phase === 'revealed' ? round.votes : null,
      createdAt: round.createdAt
    },
    iAmImpostor: player ? player.isImpostor : false,
    iSubmitted: player ? !!player.word : false,
    iVoted: player ? !!player.vote : false
  });
});

// Join / create player in current round
app.post('/api/impostor/join', requireAuth, (req, res) => {
  const db = loadDB();
  let round = getImpostorState(db);
  if (!round || round.phase !== 'submission') return res.json({ success: true }); // no active round
  if (!round.players[req.session.user.id]) {
    round.players[req.session.user.id] = {
      userId: req.session.user.id,
      username: req.session.user.globalName || req.session.user.username,
      avatar: req.session.user.avatar,
      isImpostor: false,
      word: null,
      vote: null
    };
    saveImpostorState(db, round);
  }
  res.json({ success: true, playerCount: Object.keys(round.players).length });
});

// Submit word association
app.post('/api/impostor/submit', requireAuth, (req, res) => {
  const { word } = req.body;
  if (!word || !word.trim()) return res.status(400).json({ error: res.locals.t('impostor.word_required') });

  const db = loadDB();
  const round = getImpostorState(db);
  if (!round || round.phase !== 'submission') return res.status(400).json({ error: res.locals.t('impostor.not_submission_phase') });

  const player = round.players[req.session.user.id];
  if (!player) return res.status(400).json({ error: res.locals.t('impostor.join_first') });
  if (player.word) return res.status(400).json({ error: res.locals.t('impostor.already_submitted') });

  player.word = word.trim();
  saveImpostorState(db, round);
  res.json({ success: true });
});

// Vote for impostor
app.post('/api/impostor/vote', requireAuth, (req, res) => {
  const { targetId } = req.body;
  if (!targetId) return res.status(400).json({ error: res.locals.t('impostor.vote_required') });

  const db = loadDB();
  const round = getImpostorState(db);
  if (!round || round.phase !== 'voting') return res.status(400).json({ error: res.locals.t('impostor.not_voting_phase') });

  const player = round.players[req.session.user.id];
  if (!player) return res.status(400).json({ error: res.locals.t('impostor.join_first') });
  if (player.vote) return res.status(400).json({ error: res.locals.t('impostor.already_voted') });
  if (!round.players[targetId]) return res.status(400).json({ error: res.locals.t('impostor.invalid_target') });
  if (targetId === req.session.user.id) return res.status(400).json({ error: res.locals.t('impostor.cannot_self_vote') });

  player.vote = targetId;
  saveImpostorState(db, round);
  res.json({ success: true });
});

// --- Admin Impostor API ---

// Get word pairs
app.get('/api/admin/impostor-words', requireAuth, requireAdmin, (req, res) => {
  res.json(loadImpostorWords());
});

// Get history
app.get('/api/admin/impostor/history', requireAuth, requireAdmin, (req, res) => {
  const db = loadDB();
  res.json((db.impostorRounds || []).slice(-10).reverse());
});

// Start a new round
app.post('/api/admin/impostor/start', requireAuth, requireAdmin, (req, res) => {
  const { realWord, fakeWord } = req.body;
  if (!realWord || !fakeWord) return res.status(400).json({ error: res.locals.t('impostor.words_required') });

  const db = loadDB();

  const round = {
    id: Date.now(),
    realWord: realWord.trim(),
    fakeWord: fakeWord.trim(),
    impostorId: null,
    phase: 'submission',
    players: {},
    createdBy: req.session.user.username,
    createdAt: new Date().toISOString()
  };

  if (!db.impostorRounds) db.impostorRounds = [];
  db.impostorRounds.push(round);
  saveDB(db);

  res.json({ success: true, roundId: round.id });
});

// Start a round with random words from bank
app.post('/api/admin/impostor/start-random', requireAuth, requireAdmin, (req, res) => {
  const words = loadImpostorWords();
  if (words.length === 0) return res.status(400).json({ error: res.locals.t('impostor.no_words') });

  const pair = words[Math.floor(Math.random() * words.length)];
  const lang = res.locals.lang || 'fr';
  const realWord = (pair.real[lang] || pair.real.fr);
  const fakeWord = (pair.fake[lang] || pair.fake.fr);

  const db = loadDB();
  const round = {
    id: Date.now(),
    realWord: realWord.trim(),
    fakeWord: fakeWord.trim(),
    impostorId: null,
    phase: 'submission',
    players: {},
    createdBy: req.session.user.username,
    createdAt: new Date().toISOString()
  };
  if (!db.impostorRounds) db.impostorRounds = [];
  db.impostorRounds.push(round);
  saveDB(db);
  res.json({ success: true, roundId: round.id, realWord, fakeWord });
});

// Assign impostor (admin picks who or random)
app.post('/api/admin/impostor/assign', requireAuth, requireAdmin, (req, res) => {
  const { targetId } = req.body;
  const db = loadDB();
  const round = getImpostorState(db);
  if (!round || round.phase !== 'submission') return res.status(400).json({ error: res.locals.t('impostor.no_round') });

  const playerIds = Object.keys(round.players);
  if (playerIds.length < 2) return res.status(400).json({ error: res.locals.t('impostor.need_players') });

  // Reset any existing impostor
  Object.values(round.players).forEach(p => { p.isImpostor = false; });

  const impostorId = targetId || playerIds[Math.floor(Math.random() * playerIds.length)];
  round.impostorId = impostorId;
  if (round.players[impostorId]) round.players[impostorId].isImpostor = true;

  saveImpostorState(db, round);
  res.json({ success: true, impostorId });
});

// Move to voting phase
app.post('/api/admin/impostor/voting-phase', requireAuth, requireAdmin, (req, res) => {
  const db = loadDB();
  const round = getImpostorState(db);
  if (!round || round.phase !== 'submission') return res.status(400).json({ error: res.locals.t('impostor.no_round') });

  round.phase = 'voting';
  saveImpostorState(db, round);
  res.json({ success: true });
});

// Reveal results
app.post('/api/admin/impostor/reveal', requireAuth, requireAdmin, (req, res) => {
  const db = loadDB();
  const round = getImpostorState(db);
  if (!round || round.phase !== 'voting') return res.status(400).json({ error: res.locals.t('impostor.no_round') });

  const impostorId = round.impostorId;
  const votes = {};
  Object.values(round.players).forEach(p => {
    if (p.vote) votes[p.vote] = (votes[p.vote] || 0) + 1;
  });

  // Impostor wins if not voted out by majority
  const impostorVotes = votes[impostorId] || 0;
  const totalVoters = Object.values(round.players).filter(p => p.vote).length;
  const majority = totalVoters > 0 && impostorVotes > totalVoters / 2;

  round.winner = majority ? 'players' : 'impostor';
  round.votes = votes;
  round.phase = 'revealed';
  saveImpostorState(db, round);
  res.json({ success: true, winner: round.winner });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Serveur UAC lancé sur http://localhost:${PORT}`);
  console.log(`Admins configurés: ${ADMINS.join(', ') || 'aucun'}`);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('⚠️  DISCORD_CLIENT_ID et DISCORD_CLIENT_SECRET doivent être configurés dans .env');
  }
});
