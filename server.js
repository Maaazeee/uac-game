require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'uac-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.isAdmin) return next();
  res.status(403).send('Accès refusé. Vous devez être admin.');
}

// --- Routes ---

// Login - redirect to Discord
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/games');
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
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
    res.send('Erreur d\'authentification. Vérifie les logs.');
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

// Games hub
app.get('/games', requireAuth, (req, res) => {
  res.render('games', { user: req.session.user });
});

// --- API ---

// Get current game state
app.get('/api/state', (req, res) => {
  const db = loadDB();
  const currentRound = db.rounds[db.rounds.length - 1] || null;
  if (!currentRound) return res.json({ round: null, bets: [] });

  const bets = (currentRound.bets || []).map(b => {
    // Don't expose who voted to other players before reveal
    const isRevealed = currentRound.revealed;
    if (isRevealed) return b;
    // Before reveal, only show anonymous bet count + values (no names)
    return {
      value: b.value,
      reason: b.reason || null,
      anonymous: true
    };
  });

  res.json({
    round: {
      id: currentRound.id,
      question: currentRound.question,
      contextImg: currentRound.contextImg || null,
      answer: currentRound.revealed ? currentRound.answer : null,
      reason: currentRound.revealed ? currentRound.reason : null,
      revealed: currentRound.revealed
    },
    bets
  });
});

// Submit bet
app.post('/api/bet', requireAuth, (req, res) => {
  const { value, reason } = req.body;
  if (value === undefined || value === null) return res.status(400).json({ error: 'Valeur requise' });
  const num = parseFloat(value);
  if (isNaN(num)) return res.status(400).json({ error: 'Valeur invalide' });

  const db = loadDB();
  const round = db.rounds[db.rounds.length - 1];
  if (!round || round.revealed) return res.status(400).json({ error: 'Aucune manche en cours' });

  // Check if user already bet
  if (round.bets.find(b => b.userId === req.session.user.id)) {
    return res.status(400).json({ error: 'Tu as déjà voté !' });
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
  const { question, answer, reason, contextImg } = req.body;
  if (!question || answer === undefined) return res.status(400).json({ error: 'Question et réponse requises' });

  const db = loadDB();
  const round = {
    id: Date.now(),
    question,
    answer: parseFloat(answer),
    reason: reason || null,
    contextImg: contextImg || null,
    revealed: true, // Auto-reveal so players see answer immediately
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
  if (!round) return res.status(400).json({ error: 'Aucune manche' });

  round.revealed = true;
  saveDB(db);
  res.json({ success: true });
});

// Get all rounds (admin)
app.get('/api/admin/history', requireAuth, requireAdmin, (req, res) => {
  const db = loadDB();
  res.json(db.rounds.slice(-20).reverse());
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Serveur UAC lancé sur http://localhost:${PORT}`);
  console.log(`Admins configurés: ${ADMINS.join(', ') || 'aucun'}`);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('⚠️  DISCORD_CLIENT_ID et DISCORD_CLIENT_SECRET doivent être configurés dans .env');
  }
});
