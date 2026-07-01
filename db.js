const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const DB_PATH = path.join(__dirname, 'data', 'database.sqlite');
const JSON_DB_PATH = path.join(__dirname, 'data', 'db.json');
const QUESTIONS_PATH = path.join(__dirname, 'questions.json');
const WORDS_PATH = path.join(__dirname, 'impostor-words.json');

let db = null;
let SQL = null;

async function init() {
  SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
    logger.info('Loaded existing SQLite database');
  } else {
    db = new SQL.Database();
    logger.info('Created new SQLite database');
  }
  createSchema();
  if (fs.existsSync(JSON_DB_PATH)) migrateFromJson();
  if (fs.existsSync(QUESTIONS_PATH)) migrateQuestions();
  if (fs.existsSync(WORDS_PATH)) migrateWords();
  return db;
}

function save() {
  const buf = db.export();
  const tmp = DB_PATH + '.tmp.' + Date.now();
  fs.writeFileSync(tmp, Buffer.from(buf));
  fs.renameSync(tmp, DB_PATH);
}

function createSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL DEFAULT '',
    globalName TEXT DEFAULT '', avatar TEXT DEFAULT '',
    discriminator TEXT DEFAULT '', isAdmin INTEGER DEFAULT 0,
    createdAt TEXT DEFAULT ''
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY, question TEXT NOT NULL,
    answer REAL NOT NULL, reason TEXT DEFAULT '',
    contextImg TEXT DEFAULT '', revealed INTEGER DEFAULT 0,
    deadline INTEGER, createdBy TEXT DEFAULT '', createdAt TEXT DEFAULT ''
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roundId INTEGER NOT NULL, userId TEXT NOT NULL,
    username TEXT DEFAULT '', avatar TEXT DEFAULT '',
    value REAL NOT NULL, reason TEXT DEFAULT '',
    time INTEGER, FOREIGN KEY(roundId) REFERENCES rounds(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS impostor_rounds (
    id INTEGER PRIMARY KEY, realWord TEXT NOT NULL,
    fakeWord TEXT NOT NULL, impostorId TEXT DEFAULT '',
    phase TEXT DEFAULT 'submission', winner TEXT DEFAULT '',
    createdBy TEXT DEFAULT '', createdAt TEXT DEFAULT ''
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS impostor_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roundId INTEGER NOT NULL, userId TEXT NOT NULL,
    username TEXT DEFAULT '', avatar TEXT DEFAULT '',
    isImpostor INTEGER DEFAULT 0, word TEXT DEFAULT '',
    vote TEXT DEFAULT '', FOREIGN KEY(roundId) REFERENCES impostor_rounds(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS impostor_points (
    roundId INTEGER NOT NULL, userId TEXT NOT NULL,
    points INTEGER DEFAULT 0,
    PRIMARY KEY(roundId, userId)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    q_fr TEXT DEFAULT '', q_en TEXT DEFAULT '', q_ar TEXT DEFAULT '',
    a REAL NOT NULL, r_fr TEXT DEFAULT '', r_en TEXT DEFAULT '', r_ar TEXT DEFAULT ''
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS impostor_words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    real_fr TEXT DEFAULT '', real_en TEXT DEFAULT '', real_ar TEXT DEFAULT '',
    fake_fr TEXT DEFAULT '', fake_en TEXT DEFAULT '', fake_ar TEXT DEFAULT ''
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_bets_roundId ON bets(roundId)');
  db.run('CREATE INDEX IF NOT EXISTS idx_bets_userId ON bets(userId)');
  db.run('CREATE INDEX IF NOT EXISTS idx_rounds_revealed ON rounds(revealed)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ip_roundId ON impostor_players(roundId)');
}

// --- Migration ---

function migrateFromJson() {
  logger.info('Migrating data from db.json to SQLite...');
  try {
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    if (data.users && data.users.length > 0) {
      const stmt = db.prepare('INSERT OR REPLACE INTO users(id,username,globalName,avatar,discriminator,isAdmin,createdAt) VALUES(?,?,?,?,?,?,?)');
      for (const u of data.users) {
        stmt.run([u.id, u.username||'', u.globalName||'', u.avatar||'', u.discriminator||'', u.isAdmin?1:0, u.createdAt||'']);
      }
      stmt.free();
    }
    if (data.rounds && data.rounds.length > 0) {
      const rStmt = db.prepare('INSERT OR REPLACE INTO rounds(id,question,answer,reason,contextImg,revealed,deadline,createdBy,createdAt) VALUES(?,?,?,?,?,?,?,?,?)');
      const bStmt = db.prepare('INSERT INTO bets(roundId,userId,username,avatar,value,reason,time) VALUES(?,?,?,?,?,?,?)');
      for (const r of data.rounds) {
        rStmt.run([r.id, r.question||'', r.answer, r.reason||'', r.contextImg||'', r.revealed?1:0, r.deadline||null, r.createdBy||'', r.createdAt||'']);
        if (r.bets) {
          for (const b of r.bets) {
            bStmt.run([r.id, b.userId, b.username||'', b.avatar||'', b.value, b.reason||'', b.time||null]);
          }
        }
      }
      rStmt.free(); bStmt.free();
    }
    if (data.impostorRounds && data.impostorRounds.length > 0) {
      const irStmt = db.prepare('INSERT OR REPLACE INTO impostor_rounds(id,realWord,fakeWord,impostorId,phase,winner,createdBy,createdAt) VALUES(?,?,?,?,?,?,?,?)');
      const ipStmt = db.prepare('INSERT INTO impostor_players(roundId,userId,username,avatar,isImpostor,word,vote) VALUES(?,?,?,?,?,?,?)');
      const ptStmt = db.prepare('INSERT OR REPLACE INTO impostor_points(roundId,userId,points) VALUES(?,?,?)');
      for (const ir of data.impostorRounds) {
        irStmt.run([ir.id, ir.realWord||'', ir.fakeWord||'', ir.impostorId||'', ir.phase||'submission', ir.winner||'', ir.createdBy||'', ir.createdAt||'']);
        if (ir.players) {
          for (const pid of Object.keys(ir.players)) {
            const p = ir.players[pid];
            ipStmt.run([ir.id, pid, p.username||'', p.avatar||'', p.isImpostor?1:0, p.word||'', p.vote||'']);
          }
        }
        if (ir.points) {
          for (const [pid, pts] of Object.entries(ir.points)) {
            ptStmt.run([ir.id, pid, pts]);
          }
        }
      }
      irStmt.free(); ipStmt.free(); ptStmt.free();
    }
    save();
    logger.info('Migration from db.json complete');
  } catch (err) {
    logger.error({ err }, 'Migration from db.json failed');
  }
}

function migrateQuestions() {
  try {
    const qs = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
    if (!qs.length) return;
    const stmt = db.prepare('INSERT INTO questions(q_fr,q_en,q_ar,a,r_fr,r_en,r_ar) VALUES(?,?,?,?,?,?,?)');
    for (const q of qs) {
      if (typeof q.q === 'object') {
        stmt.run([q.q.fr||'', q.q.en||'', q.q.ar||'', q.a, q.r?.fr||'', q.r?.en||'', q.r?.ar||'']);
      } else {
        stmt.run([q.q||'', '', '', q.a, q.r||'', '', '']);
      }
    }
    stmt.free(); save();
    logger.info('Migrated questions.json to SQLite');
  } catch (err) {
    logger.error({ err }, 'Questions migration failed');
  }
}

function migrateWords() {
  try {
    const ws = JSON.parse(fs.readFileSync(WORDS_PATH, 'utf8'));
    if (!ws.length) return;
    const stmt = db.prepare('INSERT INTO impostor_words(real_fr,real_en,real_ar,fake_fr,fake_en,fake_ar) VALUES(?,?,?,?,?,?)');
    for (const w of ws) {
      stmt.run([w.real?.fr||'', w.real?.en||'', w.real?.ar||'', w.fake?.fr||'', w.fake?.en||'', w.fake?.ar||'']);
    }
    stmt.free(); save();
    logger.info('Migrated impostor-words.json to SQLite');
  } catch (err) {
    logger.error({ err }, 'Words migration failed');
  }
}

// --- Users ---

function getUser(id) {
  const r = db.exec('SELECT * FROM users WHERE id = ?', [id]);
  if (!r.length || !r[0].values.length) return null;
  return rowToUser(r[0], r[0].values[0]);
}

function upsertUser(u) {
  const existing = db.exec('SELECT * FROM users WHERE id = ?', [u.id]);
  if (existing.length && existing[0].values.length) {
    db.run('UPDATE users SET username=?,globalName=?,avatar=?,isAdmin=? WHERE id=?',
      [u.username||'', u.globalName||'', u.avatar||'', u.isAdmin?1:0, u.id]);
  } else {
    db.run('INSERT INTO users(id,username,globalName,avatar,discriminator,isAdmin,createdAt) VALUES(?,?,?,?,?,?,?)',
      [u.id, u.username||'', u.globalName||'', u.avatar||'', u.discriminator||'', u.isAdmin?1:0, new Date().toISOString()]);
  }
  save();
  return getUser(u.id);
}

function rowToUser(meta, row) {
  const cols = meta.columns;
  const obj = {};
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
  obj.isAdmin = !!obj.isAdmin;
  return obj;
}

// --- Rounds (Juste Prix) ---

function getCurrentRound() {
  const r = db.exec('SELECT * FROM rounds ORDER BY id DESC LIMIT 1');
  if (!r.length || !r[0].values.length) return null;
  const round = rowToRound(r[0], r[0].values[0]);
  round.bets = getBets(round.id);
  return round;
}

function getAllRounds() {
  const r = db.exec('SELECT * FROM rounds ORDER BY id ASC');
  if (!r.length) return [];
  const rounds = r[0].values.map(row => {
    const round = rowToRound(r[0], row);
    round.bets = getBets(round.id);
    return round;
  });
  return rounds;
}

function getBets(roundId) {
  const r = db.exec('SELECT * FROM bets WHERE roundId = ? ORDER BY time ASC', [roundId]);
  if (!r.length) return [];
  return r[0].values.map(row => {
    const cols = r[0].columns;
    const obj = {};
    for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
    return obj;
  });
}

function rowToRound(meta, row) {
  const cols = meta.columns;
  const obj = {};
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
  obj.revealed = !!obj.revealed;
  return obj;
}

function createRound(data) {
  db.run('INSERT INTO rounds(id,question,answer,reason,contextImg,revealed,deadline,createdBy,createdAt) VALUES(?,?,?,?,?,?,?,?,?)',
    [data.id, data.question, data.answer, data.reason||'', data.contextImg||'', data.revealed?1:0, data.deadline||null, data.createdBy||'', data.createdAt||'']);
  save();
  return getCurrentRound();
}

function updateRound(id, fields) {
  const sets = []; const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k}=?`);
    vals.push(v);
  }
  vals.push(id);
  db.run(`UPDATE rounds SET ${sets.join(',')} WHERE id=?`, vals);
  save();
}

function addBet(roundId, bet) {
  db.run('INSERT INTO bets(roundId,userId,username,avatar,value,reason,time) VALUES(?,?,?,?,?,?,?)',
    [roundId, bet.userId, bet.username||'', bet.avatar||'', bet.value, bet.reason||'', bet.time||null]);
  save();
}

// --- Impostor ---

function getImpostorState() {
  const r = db.exec('SELECT * FROM impostor_rounds ORDER BY id DESC LIMIT 1');
  if (!r.length || !r[0].values.length) return null;
  const round = rowToImpostorRound(r[0], r[0].values[0]);
  round.players = getImpostorPlayers(round.id);
  round.points = getImpostorPoints(round.id);
  round.votes = {};
  if (round.phase === 'revealed') {
    for (const p of Object.values(round.players)) {
      if (p.vote) round.votes[p.vote] = (round.votes[p.vote] || 0) + 1;
    }
  }
  return round;
}

function getImpostorPlayers(roundId) {
  const r = db.exec('SELECT * FROM impostor_players WHERE roundId = ?', [roundId]);
  if (!r.length) return {};
  const players = {};
  for (const row of r[0].values) {
    const obj = {};
    for (let i = 0; i < r[0].columns.length; i++) obj[r[0].columns[i]] = row[i];
    obj.isImpostor = !!obj.isImpostor;
    players[obj.userId] = { userId: obj.userId, username: obj.username, avatar: obj.avatar, isImpostor: obj.isImpostor, word: obj.word, vote: obj.vote };
  }
  return players;
}

function getImpostorPoints(roundId) {
  const r = db.exec('SELECT userId,points FROM impostor_points WHERE roundId = ?', [roundId]);
  if (!r.length) return {};
  const pts = {};
  for (const row of r[0].values) pts[row[0]] = row[1];
  return pts;
}

function rowToImpostorRound(meta, row) {
  const cols = meta.columns;
  const obj = {};
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
  return obj;
}

function createImpostorRound(data) {
  db.run('INSERT INTO impostor_rounds(id,realWord,fakeWord,impostorId,phase,winner,createdBy,createdAt) VALUES(?,?,?,?,?,?,?,?)',
    [data.id, data.realWord, data.fakeWord, data.impostorId||'', data.phase||'submission', data.winner||'', data.createdBy||'', data.createdAt||'']);
  save();
  return getImpostorState();
}

function updateImpostorRound(id, fields) {
  const sets = []; const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k}=?`);
    vals.push(v);
  }
  vals.push(id);
  db.run(`UPDATE impostor_rounds SET ${sets.join(',')} WHERE id=?`, vals);
  save();
}

function upsertImpostorPlayer(roundId, player) {
  const existing = db.exec('SELECT id FROM impostor_players WHERE roundId=? AND userId=?', [roundId, player.userId]);
  if (existing.length && existing[0].values.length) {
    db.run('UPDATE impostor_players SET username=?,avatar=?,isImpostor=?,word=?,vote=? WHERE roundId=? AND userId=?',
      [player.username||'', player.avatar||'', player.isImpostor?1:0, player.word||'', player.vote||'', roundId, player.userId]);
  } else {
    db.run('INSERT INTO impostor_players(roundId,userId,username,avatar,isImpostor,word,vote) VALUES(?,?,?,?,?,?,?)',
      [roundId, player.userId, player.username||'', player.avatar||'', player.isImpostor?1:0, player.word||'', player.vote||'']);
  }
  save();
}

function addImpostorPoints(roundId, userId, points) {
  db.run('INSERT OR REPLACE INTO impostor_points(roundId,userId,points) VALUES(?,?,?)', [roundId, userId, points]);
  save();
}

// --- Leaderboard ---

function getLeaderboard(type = 'global') {
  if (type === 'justeprix') return getJustePrixLeaderboard();
  if (type === 'impostor') return getImpostorOnlyLeaderboard();
  return getGlobalLeaderboard();
}

function getGlobalLeaderboard() {
  const jp = getJustePrixLeaderboard();
  const imp = getImpostorOnlyLeaderboard();
  const merged = {};
  for (const u of jp) {
    merged[u.userId] = { userId: u.userId, username: u.username, avatar: u.avatar, points: u.points, wins: u.wins, bets: u.bets, impostorGames: 0, impostorWins: 0 };
  }
  for (const u of imp) {
    if (merged[u.userId]) {
      merged[u.userId].points += u.points;
      merged[u.userId].impostorGames = u.bets;
      merged[u.userId].impostorWins = u.wins;
    } else {
      merged[u.userId] = { userId: u.userId, username: u.username, avatar: u.avatar, points: u.points, wins: 0, bets: 0, impostorGames: u.bets, impostorWins: u.wins };
    }
  }
  return Object.values(merged).sort((a, b) => b.points - a.points || b.wins - a.wins || b.bets - a.bets);
}

function getJustePrixLeaderboard() {
  const r = db.exec(`
    WITH ranked AS (
      SELECT b.userId, b.username, b.avatar, r.id as rid,
        ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY ABS(b.value - r.answer) ASC, CASE WHEN b.value <= r.answer THEN 0 ELSE 1 END ASC) as rnk
      FROM bets b JOIN rounds r ON b.roundId = r.id WHERE r.revealed = 1
    )
    SELECT userId, MAX(username) as username, MAX(avatar) as avatar,
      SUM(CASE WHEN rnk=1 THEN 3 WHEN rnk=2 THEN 2 WHEN rnk=3 THEN 1 ELSE 0 END) as points,
      SUM(CASE WHEN rnk=1 THEN 1 ELSE 0 END) as wins,
      COUNT(*) as bets
    FROM ranked GROUP BY userId ORDER BY points DESC, wins DESC, bets DESC
  `);
  if (!r.length) return [];
  return r[0].values.map(row => ({ userId: row[0], username: row[1], avatar: row[2], points: row[3], wins: row[4], bets: row[5] }));
}

function getImpostorOnlyLeaderboard() {
  const r = db.exec(`
    SELECT ip.userId, MAX(ip.username) as username, MAX(ip.avatar) as avatar,
      SUM(COALESCE(ipt.points,0)) as points,
      SUM(CASE WHEN ipt.points >= 3 THEN 1 ELSE 0 END) as wins,
      COUNT(DISTINCT ip.roundId) as bets
    FROM impostor_players ip
    JOIN impostor_rounds ir ON ip.roundId = ir.id
    LEFT JOIN impostor_points ipt ON ip.roundId = ipt.roundId AND ip.userId = ipt.userId
    WHERE ir.phase = 'revealed'
    GROUP BY ip.userId ORDER BY points DESC, wins DESC
  `);
  if (!r.length) return [];
  return r[0].values.map(row => ({ userId: row[0], username: row[1], avatar: row[2], points: row[3], wins: row[4], bets: row[5] }));
}

// --- Profile ---

function getUserStats(userId) {
  const r = db.exec(`
    WITH ranked AS (
      SELECT r.id, r.question, r.answer, b.value, b.time, b.username,
        ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY ABS(b.value - r.answer) ASC, CASE WHEN b.value <= r.answer THEN 0 ELSE 1 END ASC) as rnk,
        (SELECT COUNT(*) FROM bets WHERE roundId = r.id) as total
      FROM bets b JOIN rounds r ON b.roundId = r.id
      WHERE b.userId = ? AND r.revealed = 1
      ORDER BY r.createdAt DESC
    )
    SELECT *, (SELECT MIN(rnk) FROM ranked r2 WHERE r2.id = ranked.id) as minRnk
    FROM ranked
  `, [userId]);
  const history = [];
  let totalBets = 0, wins = 0, points = 0, bestRank = null, top3Count = 0;
  if (r.length && r[0].values.length) {
    for (const row of r[0].values) {
      const rank = row[3]; // rnk
      totalBets++;
      history.push({ question: row[1], value: row[4], answer: row[2], rank, total: row[8], createdAt: row[5] });
      if (rank === 1) { wins++; points += 3; }
      else if (rank === 2) points += 2;
      else if (rank === 3) points += 1;
      if (rank <= 3) top3Count++;
      if (bestRank === null || rank < bestRank) bestRank = rank;
    }
  }
  return { totalBets, wins, points, bestRank, top3Count, gameHistory: history };
}

function getImpostorStats(userId) {
  const r = db.exec(`
    SELECT ip.isImpostor, COALESCE(ipt.points,0) as pts,
      ir.winner, ip.roundId
    FROM impostor_players ip
    JOIN impostor_rounds ir ON ip.roundId = ir.id
    LEFT JOIN impostor_points ipt ON ip.roundId = ipt.roundId AND ip.userId = ipt.userId
    WHERE ip.userId = ? AND ir.phase = 'revealed'
  `, [userId]);
  let games = 0, impostorAssignments = 0, impostorWins = 0, impostorPoints = 0;
  if (r.length && r[0].values.length) {
    for (const row of r[0].values) {
      games++;
      if (row[0]) impostorAssignments++; // isImpostor
      impostorPoints += row[1];
      if (row[2] === 'impostor' && row[0]) impostorWins++;
      if (row[2] === 'players' && !row[0]) impostorWins++;
    }
  }
  return { impostorGames: games, impostorWins, impostorAssignments, impostorPoints };
}

// --- Questions ---

function getAllQuestions() {
  const r = db.exec('SELECT * FROM questions ORDER BY id ASC');
  if (!r.length) return [];
  return r[0].values.map(row => {
    const obj = {};
    for (let i = 0; i < r[0].columns.length; i++) obj[r[0].columns[i]] = row[i];
    return { q: { fr: obj.q_fr||'', en: obj.q_en||'', ar: obj.q_ar||'' }, a: obj.a, r: { fr: obj.r_fr||'', en: obj.r_en||'', ar: obj.r_ar||'' } };
  });
}

function addQuestion(data) {
  const q = data.q || {};
  const r = data.r || {};
  db.run('INSERT INTO questions(q_fr,q_en,q_ar,a,r_fr,r_en,r_ar) VALUES(?,?,?,?,?,?,?)',
    [(q.fr||'').trim(), (q.en||'').trim(), (q.ar||'').trim(), data.a, (r.fr||'').trim(), (r.en||'').trim(), (r.ar||'').trim()]);
  save();
}

function updateQuestion(id, data) {
  const q = data.q || {};
  const r = data.r || {};
  db.run('UPDATE questions SET q_fr=?,q_en=?,q_ar=?,a=?,r_fr=?,r_en=?,r_ar=? WHERE id=?',
    [(q.fr||'').trim(), (q.en||'').trim(), (q.ar||'').trim(), data.a, (r.fr||'').trim(), (r.en||'').trim(), (r.ar||'').trim(), id]);
  save();
}

function deleteQuestion(id) {
  db.run('DELETE FROM questions WHERE id=?', [id]);
  save();
}

function getRandomQuestion(lang) {
  const r = db.exec('SELECT * FROM questions ORDER BY RANDOM() LIMIT 1');
  if (!r.length || !r[0].values.length) return { q: '', a: 0, r: '' };
  const row = r[0].values[0];
  const cols = r[0].columns;
  const obj = {};
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
  const l = lang || 'fr';
  return { q: obj['q_' + l] || obj.q_fr, a: obj.a, r: obj['r_' + l] || obj.r_fr };
}

// --- Impostor Words ---

function getAllWords() {
  const r = db.exec('SELECT * FROM impostor_words ORDER BY id ASC');
  if (!r.length) return [];
  return r[0].values.map(row => {
    const obj = {};
    for (let i = 0; i < r[0].columns.length; i++) obj[r[0].columns[i]] = row[i];
    return { real: { fr: obj.real_fr, en: obj.real_en, ar: obj.real_ar }, fake: { fr: obj.fake_fr, en: obj.fake_en, ar: obj.fake_ar } };
  });
}

function addWord(data) {
  db.run('INSERT INTO impostor_words(real_fr,real_en,real_ar,fake_fr,fake_en,fake_ar) VALUES(?,?,?,?,?,?)',
    [(data.real?.fr||'').trim(), (data.real?.en||'').trim(), (data.real?.ar||'').trim(), (data.fake?.fr||'').trim(), (data.fake?.en||'').trim(), (data.fake?.ar||'').trim()]);
  save();
}

function getRandomWord(lang) {
  const r = db.exec('SELECT * FROM impostor_words ORDER BY RANDOM() LIMIT 1');
  if (!r.length || !r[0].values.length) return null;
  const row = r[0].values[0];
  const cols = r[0].columns;
  const obj = {};
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
  const l = lang || 'fr';
  return { real: obj['real_' + l] || obj.real_fr, fake: obj['fake_' + l] || obj.fake_fr };
}

function getLastRoundIds(count = 20) {
  const r = db.exec('SELECT * FROM rounds ORDER BY id DESC LIMIT ?', [count]);
  if (!r.length) return [];
  return r[0].values.map(row => rowToRound(r[0], row));
}

function getLastImpostorRoundIds(count = 10) {
  const r = db.exec('SELECT * FROM impostor_rounds ORDER BY id DESC LIMIT ?', [count]);
  if (!r.length) return [];
  return r[0].values.map(row => rowToImpostorRound(r[0], row));
}

module.exports = {
  init, save,
  getUser, upsertUser,
  getCurrentRound, getAllRounds, createRound, updateRound, addBet, getLastRoundIds,
  getImpostorState, createImpostorRound, updateImpostorRound, upsertImpostorPlayer, addImpostorPoints, getLastImpostorRoundIds,
  getLeaderboard,
  getUserStats, getImpostorStats,
  getAllQuestions, addQuestion, updateQuestion, deleteQuestion, getRandomQuestion,
  getAllWords, addWord, getRandomWord,
  getBets, getImpostorPlayers, getImpostorPoints
};
