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
  const questions = loadQuestions();
  questions.push({ q: q.trim(), a: parseFloat(a), r: (r || '').trim() });
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
  questions[index] = { q: q.trim(), a: parseFloat(a), r: (r || '').trim() };
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

// Get random funny question
app.get('/api/admin/random-question', requireAuth, requireAdmin, (req, res) => {
  try {
    const questions = loadQuestions();
    if (questions.length === 0) return res.json({ q: "Alger est la capitale de ?", a: 1962, r: "Année d'indépendance" });
    const q = questions[Math.floor(Math.random() * questions.length)];
    res.json(q);
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

// --- Start ---
app.listen(PORT, () => {
  console.log(`Serveur UAC lancé sur http://localhost:${PORT}`);
  console.log(`Admins configurés: ${ADMINS.join(', ') || 'aucun'}`);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('⚠️  DISCORD_CLIENT_ID et DISCORD_CLIENT_SECRET doivent être configurés dans .env');
  }
});
