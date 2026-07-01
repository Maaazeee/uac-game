import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import path from 'path';
import fs from 'fs';
import logger from './logger';

const PROJECT_ROOT = fs.existsSync(path.join(__dirname, 'views')) ? __dirname : path.join(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'database.sqlite');
const JSON_DB_PATH = path.join(PROJECT_ROOT, 'data', 'db.json');
const QUESTIONS_PATH = path.join(PROJECT_ROOT, 'questions.json');
const WORDS_PATH = path.join(PROJECT_ROOT, 'impostor-words.json');

let db: SqlJsDatabase | null = null;
let SQL: SqlJsStatic | null = null;

// --- Types ---

export interface User {
  id: string; username: string; globalName: string; avatar: string;
  discriminator: string; isAdmin: boolean; createdAt: string;
}

export interface Bet {
  userId: string; username: string; avatar: string;
  value: number; reason: string | null; time: number | null;
}

export interface Round {
  id: number; question: string; answer: number; reason: string;
  contextImg: string; revealed: boolean; deadline: number | null;
  createdBy: string; createdAt: string; bets: Bet[];
}

export interface ImpostorPlayer {
  userId: string; username: string; avatar: string;
  isImpostor: boolean; word: string; vote: string;
}

export interface ImpostorRound {
  id: number; realWord: string; fakeWord: string;
  impostorId: string; phase: string; winner: string;
  deadline: number | null;
  createdBy: string; createdAt: string;
  players: Record<string, ImpostorPlayer>;
  points: Record<string, number>;
  votes: Record<string, number>;
}

export interface LeaderboardEntry {
  userId: string; username: string; avatar: string;
  points: number; wins: number; bets: number;
  impostorGames?: number; impostorWins?: number;
}

export interface UserStats {
  totalBets: number; wins: number; points: number;
  bestRank: number | null; top3Count: number;
  gameHistory: Array<{ question: string; value: number; answer: number; rank: number; total: number; createdAt: string }>;
}

export interface ImpostorStats {
  impostorGames: number; impostorWins: number;
  impostorAssignments: number; impostorPoints: number;
}

// --- Init ---

async function init(): Promise<SqlJsDatabase> {
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

function save(): void {
  if (!db) return;
  const buf = db.export();
  const tmp = DB_PATH + '.tmp.' + Date.now();
  fs.writeFileSync(tmp, Buffer.from(buf));
  fs.renameSync(tmp, DB_PATH);
}

function run(sql: string, params: unknown[] = []): void {
  if (!db) throw new Error('DB not initialized');
  db.run(sql, params);
}

function exec(sql: string, params?: unknown[]): SqlJsDatabase.QueryExecResult[] {
  if (!db) throw new Error('DB not initialized');
  return params ? db.exec(sql, params) : db.exec(sql);
}

function createSchema(): void {
  run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL DEFAULT '',
    globalName TEXT DEFAULT '', avatar TEXT DEFAULT '',
    discriminator TEXT DEFAULT '', isAdmin INTEGER DEFAULT 0,
    createdAt TEXT DEFAULT ''
  )`);
  run(`CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY, question TEXT NOT NULL,
    answer REAL NOT NULL, reason TEXT DEFAULT '',
    contextImg TEXT DEFAULT '', revealed INTEGER DEFAULT 0,
    deadline INTEGER, createdBy TEXT DEFAULT '', createdAt TEXT DEFAULT ''
  )`);
  run(`CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roundId INTEGER NOT NULL, userId TEXT NOT NULL,
    username TEXT DEFAULT '', avatar TEXT DEFAULT '',
    value REAL NOT NULL, reason TEXT DEFAULT '',
    time INTEGER, FOREIGN KEY(roundId) REFERENCES rounds(id)
  )`);
  run(`CREATE TABLE IF NOT EXISTS impostor_rounds (
    id INTEGER PRIMARY KEY, realWord TEXT NOT NULL,
    fakeWord TEXT NOT NULL, impostorId TEXT DEFAULT '',
    phase TEXT DEFAULT 'submission', winner TEXT DEFAULT '',
    deadline INTEGER, createdBy TEXT DEFAULT '', createdAt TEXT DEFAULT ''
  )`);
  try { run('ALTER TABLE impostor_rounds ADD COLUMN deadline INTEGER'); } catch (e) { /* column may already exist */ }
  run(`CREATE TABLE IF NOT EXISTS impostor_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roundId INTEGER NOT NULL, userId TEXT NOT NULL,
    username TEXT DEFAULT '', avatar TEXT DEFAULT '',
    isImpostor INTEGER DEFAULT 0, word TEXT DEFAULT '',
    vote TEXT DEFAULT '', FOREIGN KEY(roundId) REFERENCES impostor_rounds(id)
  )`);
  run(`CREATE TABLE IF NOT EXISTS impostor_points (
    roundId INTEGER NOT NULL, userId TEXT NOT NULL,
    points INTEGER DEFAULT 0, PRIMARY KEY(roundId, userId)
  )`);
  run(`CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    q_fr TEXT DEFAULT '', q_en TEXT DEFAULT '', q_ar TEXT DEFAULT '',
    a REAL NOT NULL, r_fr TEXT DEFAULT '', r_en TEXT DEFAULT '', r_ar TEXT DEFAULT ''
  )`);
  run(`CREATE TABLE IF NOT EXISTS impostor_words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    real_fr TEXT DEFAULT '', real_en TEXT DEFAULT '', real_ar TEXT DEFAULT '',
    fake_fr TEXT DEFAULT '', fake_en TEXT DEFAULT '', fake_ar TEXT DEFAULT ''
  )`);
  run('CREATE INDEX IF NOT EXISTS idx_bets_roundId ON bets(roundId)');
  run('CREATE INDEX IF NOT EXISTS idx_bets_userId ON bets(userId)');
  run('CREATE INDEX IF NOT EXISTS idx_rounds_revealed ON rounds(revealed)');
  run('CREATE INDEX IF NOT EXISTS idx_ip_roundId ON impostor_players(roundId)');
}

// --- Migration ---

function migrateFromJson(): void {
  logger.info('Migrating data from db.json to SQLite...');
  try {
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    if (data.users?.length) {
      const stmt = db!.prepare('INSERT OR REPLACE INTO users(id,username,globalName,avatar,discriminator,isAdmin,createdAt) VALUES(?,?,?,?,?,?,?)');
      for (const u of data.users) stmt.run([u.id, u.username||'', u.globalName||'', u.avatar||'', u.discriminator||'', u.isAdmin?1:0, u.createdAt||'']);
      stmt.free();
    }
    if (data.rounds?.length) {
      const rStmt = db!.prepare('INSERT OR REPLACE INTO rounds(id,question,answer,reason,contextImg,revealed,deadline,createdBy,createdAt) VALUES(?,?,?,?,?,?,?,?,?)');
      const bStmt = db!.prepare('INSERT INTO bets(roundId,userId,username,avatar,value,reason,time) VALUES(?,?,?,?,?,?,?)');
      for (const r of data.rounds) {
        rStmt.run([r.id, r.question||'', r.answer, r.reason||'', r.contextImg||'', r.revealed?1:0, r.deadline||null, r.createdBy||'', r.createdAt||'']);
        if (r.bets) for (const b of r.bets) bStmt.run([r.id, b.userId, b.username||'', b.avatar||'', b.value, b.reason||'', b.time||null]);
      }
      rStmt.free(); bStmt.free();
    }
    if (data.impostorRounds?.length) {
      const irStmt = db!.prepare('INSERT OR REPLACE INTO impostor_rounds(id,realWord,fakeWord,impostorId,phase,winner,createdBy,createdAt) VALUES(?,?,?,?,?,?,?,?)');
      const ipStmt = db!.prepare('INSERT INTO impostor_players(roundId,userId,username,avatar,isImpostor,word,vote) VALUES(?,?,?,?,?,?,?)');
      const ptStmt = db!.prepare('INSERT OR REPLACE INTO impostor_points(roundId,userId,points) VALUES(?,?,?)');
      for (const ir of data.impostorRounds) {
        irStmt.run([ir.id, ir.realWord||'', ir.fakeWord||'', ir.impostorId||'', ir.phase||'submission', ir.winner||'', ir.createdBy||'', ir.createdAt||'']);
        if (ir.players) for (const pid of Object.keys(ir.players)) {
          const p = ir.players[pid];
          ipStmt.run([ir.id, pid, p.username||'', p.avatar||'', p.isImpostor?1:0, p.word||'', p.vote||'']);
        }
        if (ir.points) for (const [pid, pts] of Object.entries(ir.points)) ptStmt.run([ir.id, pid, pts]);
      }
      irStmt.free(); ipStmt.free(); ptStmt.free();
    }
    save();
    logger.info('Migration from db.json complete');
  } catch (err) {
    logger.error({ err }, 'Migration from db.json failed');
  }
}

function migrateQuestions(): void {
  try {
    const qs = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
    if (!qs.length) return;
    const stmt = db!.prepare('INSERT INTO questions(q_fr,q_en,q_ar,a,r_fr,r_en,r_ar) VALUES(?,?,?,?,?,?,?)');
    for (const q of qs) {
      if (typeof q.q === 'object') stmt.run([q.q.fr||'', q.q.en||'', q.q.ar||'', q.a, q.r?.fr||'', q.r?.en||'', q.r?.ar||'']);
      else stmt.run([q.q||'', '', '', q.a, q.r||'', '', '']);
    }
    stmt.free(); save();
    logger.info('Migrated questions.json to SQLite');
  } catch (err) { logger.error({ err }, 'Questions migration failed'); }
}

function migrateWords(): void {
  try {
    const ws = JSON.parse(fs.readFileSync(WORDS_PATH, 'utf8'));
    if (!ws.length) return;
    const stmt = db!.prepare('INSERT INTO impostor_words(real_fr,real_en,real_ar,fake_fr,fake_en,fake_ar) VALUES(?,?,?,?,?,?)');
    for (const w of ws) stmt.run([w.real?.fr||'', w.real?.en||'', w.real?.ar||'', w.fake?.fr||'', w.fake?.en||'', w.fake?.ar||'']);
    stmt.free(); save();
    logger.info('Migrated impostor-words.json to SQLite');
  } catch (err) { logger.error({ err }, 'Words migration failed'); }
}

// --- Row helpers ---

function rowToObj<T>(r: SqlJsDatabase.QueryExecResult, row: unknown[]): T {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < r.columns.length; i++) obj[r.columns[i]] = row[i];
  return obj as unknown as T;
}

function rowsToArray<T>(r?: SqlJsDatabase.QueryExecResult[]): T[] {
  if (!r?.length) return [];
  return r[0].values.map(row => rowToObj<T>(r[0], row));
}

function firstRow<T>(r?: SqlJsDatabase.QueryExecResult[]): T | null {
  if (!r?.length || !r[0].values.length) return null;
  return rowToObj<T>(r[0], r[0].values[0]);
}

// --- Users ---

function getUser(id: string): User | null {
  const r = exec('SELECT * FROM users WHERE id = ?', [id]);
  const u = firstRow<Record<string, unknown>>(r);
  if (!u) return null;
  return { ...u, isAdmin: !!u.isAdmin } as unknown as User;
}

function upsertUser(u: { id: string; username: string; globalName: string; avatar: string; discriminator: string; isAdmin: boolean }): User | null {
  const existing = exec('SELECT * FROM users WHERE id = ?', [u.id]);
  if (existing.length && existing[0].values.length) {
    run('UPDATE users SET username=?,globalName=?,avatar=?,isAdmin=? WHERE id=?', [u.username||'', u.globalName||'', u.avatar||'', u.isAdmin?1:0, u.id]);
  } else {
    run('INSERT INTO users(id,username,globalName,avatar,discriminator,isAdmin,createdAt) VALUES(?,?,?,?,?,?,?)',
      [u.id, u.username||'', u.globalName||'', u.avatar||'', u.discriminator||'', u.isAdmin?1:0, new Date().toISOString()]);
  }
  save();
  return getUser(u.id);
}

// --- Rounds (Juste Prix) ---

function getBets(roundId: number): Bet[] {
  return rowsToArray<Bet>(exec('SELECT userId,username,avatar,value,reason,time FROM bets WHERE roundId = ? ORDER BY time ASC', [roundId]));
}

function getCurrentRound(): Round | null {
  const r = exec('SELECT * FROM rounds ORDER BY id DESC LIMIT 1');
  const round = firstRow<Record<string, unknown>>(r);
  if (!round) return null;
  const result = { ...round, revealed: !!round.revealed, bets: [] } as unknown as Round;
  result.bets = getBets(result.id);
  return result;
}

function getAllRounds(): Round[] {
  const rounds = rowsToArray<Record<string, unknown>>(exec('SELECT * FROM rounds ORDER BY id ASC'));
  return rounds.map(r => {
    const result = { ...r, revealed: !!r.revealed } as unknown as Round;
    result.bets = getBets(result.id);
    return result;
  });
}

function createRound(data: { id: number; question: string; answer: number; reason: string; contextImg: string; revealed: boolean; deadline: number | null; createdBy: string; createdAt: string }): Round | null {
  run('INSERT INTO rounds(id,question,answer,reason,contextImg,revealed,deadline,createdBy,createdAt) VALUES(?,?,?,?,?,?,?,?,?)',
    [data.id, data.question, data.answer, data.reason||'', data.contextImg||'', data.revealed?1:0, data.deadline||null, data.createdBy||'', data.createdAt||'']);
  save();
  return getCurrentRound();
}

function updateRound(id: number, fields: Record<string, unknown>): void {
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k}=?`); vals.push(v); }
  vals.push(id);
  run(`UPDATE rounds SET ${sets.join(',')} WHERE id=?`, vals);
  save();
}

function addBet(roundId: number, bet: { userId: string; username: string; avatar: string; value: number; reason: string | null; time: number }): void {
  run('INSERT INTO bets(roundId,userId,username,avatar,value,reason,time) VALUES(?,?,?,?,?,?,?)',
    [roundId, bet.userId, bet.username||'', bet.avatar||'', bet.value, bet.reason||'', bet.time||null]);
  save();
}

// --- Impostor ---

function getImpostorPlayers(roundId: number): Record<string, ImpostorPlayer> {
  const r = exec('SELECT * FROM impostor_players WHERE roundId = ?', [roundId]);
  if (!r.length) return {};
  const players: Record<string, ImpostorPlayer> = {};
  for (const row of r[0].values) {
    const obj = rowToObj<Record<string, unknown>>(r[0], row);
    players[obj.userId as string] = {
      userId: obj.userId as string, username: obj.username as string, avatar: obj.avatar as string,
      isImpostor: !!obj.isImpostor, word: obj.word as string, vote: obj.vote as string
    };
  }
  return players;
}

function getImpostorPoints(roundId: number): Record<string, number> {
  const r = exec('SELECT userId,points FROM impostor_points WHERE roundId = ?', [roundId]);
  if (!r.length) return {};
  const pts: Record<string, number> = {};
  for (const row of r[0].values) pts[row[0] as string] = row[1] as number;
  return pts;
}

function getImpostorState(): ImpostorRound | null {
  const r = exec('SELECT * FROM impostor_rounds ORDER BY id DESC LIMIT 1');
  const round = firstRow<Record<string, unknown>>(r);
  if (!round) return null;
  const result = {
    ...round,
    deadline: round.deadline as number | null || null,
    votes: {} as Record<string, number>,
    players: {} as Record<string, ImpostorPlayer>,
    points: {} as Record<string, number>
  } as unknown as ImpostorRound;
  result.players = getImpostorPlayers(result.id);
  result.points = getImpostorPoints(result.id);
  if (result.phase === 'revealed') {
    for (const p of Object.values(result.players)) {
      if (p.vote) result.votes[p.vote] = (result.votes[p.vote] || 0) + 1;
    }
  }
  return result;
}

function createImpostorRound(data: { id: number; realWord: string; fakeWord: string; deadline: number | null; createdBy: string; createdAt: string }): ImpostorRound | null {
  run('INSERT INTO impostor_rounds(id,realWord,fakeWord,impostorId,phase,winner,deadline,createdBy,createdAt) VALUES(?,?,?,?,?,?,?,?,?)',
    [data.id, data.realWord, data.fakeWord, '', 'submission', '', data.deadline, data.createdBy||'', data.createdAt||'']);
  save();
  return getImpostorState();
}

function updateImpostorRound(id: number, fields: Record<string, unknown>): void {
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k}=?`); vals.push(v); }
  vals.push(id);
  run(`UPDATE impostor_rounds SET ${sets.join(',')} WHERE id=?`, vals);
  save();
}

function upsertImpostorPlayer(roundId: number, player: ImpostorPlayer): void {
  const existing = exec('SELECT id FROM impostor_players WHERE roundId=? AND userId=?', [roundId, player.userId]);
  if (existing.length && existing[0].values.length) {
    run('UPDATE impostor_players SET username=?,avatar=?,isImpostor=?,word=?,vote=? WHERE roundId=? AND userId=?',
      [player.username||'', player.avatar||'', player.isImpostor?1:0, player.word||'', player.vote||'', roundId, player.userId]);
  } else {
    run('INSERT INTO impostor_players(roundId,userId,username,avatar,isImpostor,word,vote) VALUES(?,?,?,?,?,?,?)',
      [roundId, player.userId, player.username||'', player.avatar||'', player.isImpostor?1:0, player.word||'', player.vote||'']);
  }
  save();
}

function addImpostorPoints(roundId: number, userId: string, points: number): void {
  run('INSERT OR REPLACE INTO impostor_points(roundId,userId,points) VALUES(?,?,?)', [roundId, userId, points]);
  save();
}

// --- Leaderboard ---

function getLeaderboard(type: string = 'global'): LeaderboardEntry[] {
  if (type === 'justeprix') return getJustePrixLeaderboard();
  if (type === 'impostor') return getImpostorOnlyLeaderboard();
  return getGlobalLeaderboard();
}

function getGlobalLeaderboard(): LeaderboardEntry[] {
  const jp = getJustePrixLeaderboard();
  const imp = getImpostorOnlyLeaderboard();
  const merged: Record<string, LeaderboardEntry> = {};
  for (const u of jp) merged[u.userId] = { ...u, impostorGames: 0, impostorWins: 0 };
  for (const u of imp) {
    if (merged[u.userId]) {
      merged[u.userId].points += u.points;
      merged[u.userId].impostorGames = u.bets;
      merged[u.userId].impostorWins = u.wins;
    } else {
      merged[u.userId] = { ...u, wins: 0, bets: 0, impostorGames: u.bets, impostorWins: u.wins };
    }
  }
  return Object.values(merged).sort((a, b) => b.points - a.points || b.wins - a.wins || b.bets - a.bets);
}

function getJustePrixLeaderboard(): LeaderboardEntry[] {
  const r = exec(`
    WITH ranked AS (
      SELECT b.userId, b.username, b.avatar, r.id as rid,
        ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY ABS(b.value - r.answer) ASC, CASE WHEN b.value <= r.answer THEN 0 ELSE 1 END ASC) as rnk
      FROM bets b JOIN rounds r ON b.roundId = r.id WHERE r.revealed = 1
    )
    SELECT userId, MAX(username) as username, MAX(avatar) as avatar,
      SUM(CASE WHEN rnk=1 THEN 3 WHEN rnk=2 THEN 2 WHEN rnk=3 THEN 1 ELSE 0 END) as points,
      SUM(CASE WHEN rnk=1 THEN 1 ELSE 0 END) as wins, COUNT(*) as bets
    FROM ranked GROUP BY userId ORDER BY points DESC, wins DESC, bets DESC
  `);
  if (!r.length) return [];
  return r[0].values.map(row => ({ userId: row[0] as string, username: row[1] as string, avatar: row[2] as string, points: row[3] as number, wins: row[4] as number, bets: row[5] as number }));
}

function getImpostorOnlyLeaderboard(): LeaderboardEntry[] {
  const r = exec(`
    SELECT ip.userId, MAX(ip.username) as username, MAX(ip.avatar) as avatar,
      SUM(COALESCE(ipt.points,0)) as points,
      SUM(CASE WHEN ipt.points >= 3 THEN 1 ELSE 0 END) as wins,
      COUNT(DISTINCT ip.roundId) as bets
    FROM impostor_players ip JOIN impostor_rounds ir ON ip.roundId = ir.id
    LEFT JOIN impostor_points ipt ON ip.roundId = ipt.roundId AND ip.userId = ipt.userId
    WHERE ir.phase = 'revealed' GROUP BY ip.userId ORDER BY points DESC, wins DESC
  `);
  if (!r.length) return [];
  return r[0].values.map(row => ({ userId: row[0] as string, username: row[1] as string, avatar: row[2] as string, points: row[3] as number, wins: row[4] as number, bets: row[5] as number }));
}

// --- Profile ---

function getUserStats(userId: string): UserStats {
  const r = exec(`
    WITH ranked AS (
      SELECT r.id, r.question, r.answer, b.value, b.time as createdAt,
        ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY ABS(b.value - r.answer) ASC, CASE WHEN b.value <= r.answer THEN 0 ELSE 1 END ASC) as rnk,
        (SELECT COUNT(*) FROM bets WHERE roundId = r.id) as total
      FROM bets b JOIN rounds r ON b.roundId = r.id
      WHERE b.userId = ? AND r.revealed = 1
    )
    SELECT * FROM ranked ORDER BY rnk ASC
  `, [userId]);
  const history: UserStats['gameHistory'] = [];
  let totalBets = 0, wins = 0, points = 0, bestRank: number | null = null, top3Count = 0;
  if (r.length && r[0].values.length) {
    for (const row of r[0].values) {
      const rank = row[5] as number;
      totalBets++;
      history.push({ question: row[1] as string, value: row[3] as number, answer: row[2] as number, rank, total: row[6] as number, createdAt: row[4] as string });
      if (rank === 1) { wins++; points += 3; }
      else if (rank === 2) points += 2;
      else if (rank === 3) points += 1;
      if (rank <= 3) top3Count++;
      if (bestRank === null || rank < bestRank) bestRank = rank;
    }
  }
  return { totalBets, wins, points, bestRank, top3Count, gameHistory: history };
}

function getImpostorStats(userId: string): ImpostorStats {
  const r = exec(`
    SELECT ip.isImpostor, COALESCE(ipt.points,0) as pts, ir.winner
    FROM impostor_players ip JOIN impostor_rounds ir ON ip.roundId = ir.id
    LEFT JOIN impostor_points ipt ON ip.roundId = ipt.roundId AND ip.userId = ipt.userId
    WHERE ip.userId = ? AND ir.phase = 'revealed'
  `, [userId]);
  let games = 0, impostorAssignments = 0, impostorWins = 0, impostorPoints = 0;
  if (r.length && r[0].values.length) {
    for (const row of r[0].values) {
      games++;
      if (row[0]) impostorAssignments++;
      impostorPoints += row[1] as number;
      if (row[2] === 'impostor' && row[0]) impostorWins++;
      if (row[2] === 'players' && !row[0]) impostorWins++;
    }
  }
  return { impostorGames: games, impostorWins, impostorAssignments, impostorPoints };
}

// --- Questions ---

function getAllQuestions(): Array<{ q: Record<string, string>; a: number; r: Record<string, string> }> {
  return rowsToArray<Record<string, unknown>>(exec('SELECT * FROM questions ORDER BY id ASC'))
    .map(obj => ({
      q: { fr: (obj.q_fr as string)||'', en: (obj.q_en as string)||'', ar: (obj.q_ar as string)||'' },
      a: obj.a as number,
      r: { fr: (obj.r_fr as string)||'', en: (obj.r_en as string)||'', ar: (obj.r_ar as string)||'' }
    }));
}

function addQuestion(data: { q: Record<string, string>; a: number; r: Record<string, string> }): void {
  run('INSERT INTO questions(q_fr,q_en,q_ar,a,r_fr,r_en,r_ar) VALUES(?,?,?,?,?,?,?)',
    [(data.q.fr||'').trim(), (data.q.en||'').trim(), (data.q.ar||'').trim(), data.a,
     (data.r.fr||'').trim(), (data.r.en||'').trim(), (data.r.ar||'').trim()]);
  save();
}

function updateQuestion(id: number, data: { q: Record<string, string>; a: number; r: Record<string, string> }): void {
  run('UPDATE questions SET q_fr=?,q_en=?,q_ar=?,a=?,r_fr=?,r_en=?,r_ar=? WHERE id=?',
    [(data.q.fr||'').trim(), (data.q.en||'').trim(), (data.q.ar||'').trim(), data.a,
     (data.r.fr||'').trim(), (data.r.en||'').trim(), (data.r.ar||'').trim(), id]);
  save();
}

function deleteQuestion(id: number): void {
  run('DELETE FROM questions WHERE id=?', [id]);
  save();
}

function getRandomQuestion(lang: string = 'fr'): { q: string; a: number; r: string } {
  const r = exec('SELECT * FROM questions ORDER BY RANDOM() LIMIT 1');
  const row = firstRow<Record<string, unknown>>(r);
  if (!row) return { q: '', a: 0, r: '' };
  const l = lang || 'fr';
  return { q: (row['q_' + l] as string) || (row.q_fr as string), a: row.a as number, r: (row['r_' + l] as string) || (row.r_fr as string) };
}

// --- Impostor Words ---

function getAllWordsWithId(): Array<{ id: number; real: Record<string, string>; fake: Record<string, string> }> {
  return rowsToArray<Record<string, unknown>>(exec('SELECT * FROM impostor_words ORDER BY id ASC'))
    .map(obj => ({
      id: obj.id as number,
      real: { fr: (obj.real_fr as string)||'', en: (obj.real_en as string)||'', ar: (obj.real_ar as string)||'' },
      fake: { fr: (obj.fake_fr as string)||'', en: (obj.fake_en as string)||'', ar: (obj.fake_ar as string)||'' }
    }));
}

function getAllWords(): Array<{ real: Record<string, string>; fake: Record<string, string> }> {
  return rowsToArray<Record<string, unknown>>(exec('SELECT * FROM impostor_words ORDER BY id ASC'))
    .map(obj => ({
      real: { fr: (obj.real_fr as string)||'', en: (obj.real_en as string)||'', ar: (obj.real_ar as string)||'' },
      fake: { fr: (obj.fake_fr as string)||'', en: (obj.fake_en as string)||'', ar: (obj.fake_ar as string)||'' }
    }));
}

function addWord(data: { real: Record<string, string>; fake: Record<string, string> }): void {
  run('INSERT INTO impostor_words(real_fr,real_en,real_ar,fake_fr,fake_en,fake_ar) VALUES(?,?,?,?,?,?)',
    [(data.real.fr||'').trim(), (data.real.en||'').trim(), (data.real.ar||'').trim(),
     (data.fake.fr||'').trim(), (data.fake.en||'').trim(), (data.fake.ar||'').trim()]);
  save();
}

function updateWord(id: number, data: { real: Record<string, string>; fake: Record<string, string> }): void {
  run('UPDATE impostor_words SET real_fr=?,real_en=?,real_ar=?,fake_fr=?,fake_en=?,fake_ar=? WHERE id=?',
    [(data.real.fr||'').trim(), (data.real.en||'').trim(), (data.real.ar||'').trim(),
     (data.fake.fr||'').trim(), (data.fake.en||'').trim(), (data.fake.ar||'').trim(), id]);
  save();
}

function deleteWord(id: number): void {
  run('DELETE FROM impostor_words WHERE id=?', [id]);
  save();
}

function getWord(id: number): { real: Record<string, string>; fake: Record<string, string> } | null {
  const r = exec('SELECT * FROM impostor_words WHERE id=?', [id]);
  const row = firstRow<Record<string, unknown>>(r);
  if (!row) return null;
  return {
    real: { fr: (row.real_fr as string)||'', en: (row.real_en as string)||'', ar: (row.real_ar as string)||'' },
    fake: { fr: (row.fake_fr as string)||'', en: (row.fake_en as string)||'', ar: (row.fake_ar as string)||'' }
  };
}

function getRandomWord(lang: string = 'fr'): { real: string; fake: string } | null {
  const r = exec('SELECT * FROM impostor_words ORDER BY RANDOM() LIMIT 1');
  const row = firstRow<Record<string, unknown>>(r);
  if (!row) return null;
  const l = lang || 'fr';
  return { real: (row['real_' + l] as string) || (row.real_fr as string), fake: (row['fake_' + l] as string) || (row.fake_fr as string) };
}

function getLastRoundIds(count: number = 20): Record<string, unknown>[] {
  return rowsToArray<Record<string, unknown>>(exec('SELECT * FROM rounds ORDER BY id DESC LIMIT ?', [count]));
}

function getLastImpostorRoundIds(count: number = 10): Record<string, unknown>[] {
  return rowsToArray<Record<string, unknown>>(exec('SELECT * FROM impostor_rounds ORDER BY id DESC LIMIT ?', [count]));
}

export {
  init, save,
  getUser, upsertUser,
  getCurrentRound, getAllRounds, createRound, updateRound, addBet, getLastRoundIds,
  getImpostorState, createImpostorRound, updateImpostorRound, upsertImpostorPlayer, addImpostorPoints, getLastImpostorRoundIds,
  getLeaderboard,
  getUserStats, getImpostorStats,
  getAllQuestions, addQuestion, updateQuestion, deleteQuestion, getRandomQuestion,
  getAllWords, getAllWordsWithId, addWord, updateWord, deleteWord, getRandomWord,
  getBets, getImpostorPlayers, getImpostorPoints
};
