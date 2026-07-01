"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const express_1 = __importDefault(require("express"));
const express_session_1 = __importDefault(require("express-session"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const axios_1 = __importDefault(require("axios"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const node_cron_1 = __importDefault(require("node-cron"));
const i18n_1 = require("./i18n");
const logger_1 = __importDefault(require("./logger"));
const errors_1 = require("./errors");
const db = __importStar(require("./db"));
const PROJECT_ROOT = fs_1.default.existsSync(path_1.default.join(__dirname, 'views')) ? __dirname : path_1.default.join(__dirname, '..');
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server);
const PORT = parseInt(process.env.PORT || '3000', 10);
// --- Env validation ---
function validateEnv() {
    const required = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) {
        logger_1.default.fatal({ missing }, 'Missing required env vars');
        process.exit(1);
    }
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'uac-secret-change-me') {
        logger_1.default.warn('SESSION_SECRET is insecure or default');
    }
}
validateEnv();
const ADMINS = (process.env.ADMINS || process.env.ADMIN_USERNAME || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const GUILD_ID = process.env.GUILD_ID || '';
// --- Middleware ---
app.set('trust proxy', 1);
app.use((0, helmet_1.default)({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
app.use(express_1.default.static(path_1.default.join(PROJECT_ROOT, 'public')));
app.set('view engine', 'ejs');
app.set('views', path_1.default.join(PROJECT_ROOT, 'views'));
app.use((0, cookie_parser_1.default)());
app.use((0, express_session_1.default)({
    secret: process.env.SESSION_SECRET || 'uac-secret-change-me',
    resave: true,
    saveUninitialized: true,
    rolling: true,
    cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(i18n_1.i18nMiddleware);
// Rate limiting
const apiLimiter = (0, express_rate_limit_1.default)({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' } });
app.use('/api/', apiLimiter);
// CSRF origin check
const ALLOWED_ORIGINS = ['https://uac-game.onrender.com', 'http://localhost:3000'];
app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method))
        return next();
    const origin = req.headers.origin || '';
    const referer = req.headers.referer || '';
    if (!origin && !referer)
        return next();
    if (ALLOWED_ORIGINS.some(o => origin.startsWith(o) || referer.startsWith(o)))
        return next();
    res.status(403).json({ error: 'Forbidden' });
});
// Request logger
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        logger_1.default.info({ method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - start, userId: req.session?.user?.id });
    });
    next();
});
// --- Error handler ---
function errorHandler(err, req, res, next) {
    if (err instanceof errors_1.AppError) {
        if (!req.path.startsWith('/api/')) {
            res.status(err.statusCode).send(res.locals?.t ? res.locals.t('errors.forbidden') : err.message);
            return;
        }
        res.status(err.statusCode).json({ error: err.message });
        return;
    }
    logger_1.default.error({ err, method: req.method, url: req.originalUrl }, 'Unhandled error');
    if (!req.path.startsWith('/api/')) {
        res.status(500).send(res.locals?.t ? res.locals.t('errors.internal') : 'Internal server error');
        return;
    }
    res.status(500).json({ error: 'Internal server error' });
}
// --- Auth middleware ---
function requireAuth(req, res, next) {
    if (req.session.user)
        return next();
    res.redirect('/login');
}
function requireAdmin(req, res, next) {
    if (req.session.user && req.session.user.isAdmin)
        return next();
    res.status(403).send(res.locals.t('errors.forbidden'));
}
function sanitize(str) {
    if (typeof str !== 'string')
        return str;
    return str.replace(/[<>]/g, '').trim();
}
// --- Socket.io user mapping for private events ---
const userSockets = new Map();
io.on('connection', (socket) => {
    logger_1.default.debug({ socketId: socket.id }, 'Socket connected');
    socket.on('register', (userId) => {
        if (!userSockets.has(userId))
            userSockets.set(userId, new Set());
        userSockets.get(userId).add(socket.id);
    });
    socket.on('disconnect', () => {
        for (const [uid, sockets] of userSockets) {
            sockets.delete(socket.id);
            if (sockets.size === 0)
                userSockets.delete(uid);
        }
        logger_1.default.debug({ socketId: socket.id }, 'Socket disconnected');
    });
});
function emitToUser(userId, event, data) {
    const sockets = userSockets.get(userId);
    if (sockets)
        for (const sid of sockets)
            io.to(sid).emit(event, data);
}
// Build full game state (same as /api/state response minus user-specific fields)
function buildGameState() {
    const round = db.getCurrentRound();
    if (!round)
        return { round: null, bets: [] };
    if (!round.revealed && round.deadline && Date.now() >= round.deadline) {
        db.updateRound(round.id, { revealed: 1 });
        round.revealed = true;
    }
    const bets = (round.bets || []).map(b => round.revealed ? b : { value: b.value, reason: b.reason || null, anonymous: true });
    return {
        round: {
            id: round.id, question: round.question, contextImg: round.contextImg || null,
            answer: round.revealed ? round.answer : null, reason: round.revealed ? round.reason : null,
            revealed: round.revealed, deadline: round.deadline || null, createdAt: round.createdAt
        }, bets
    };
}
function buildImpostorState() {
    const round = db.getImpostorState();
    if (!round)
        return { round: null };
    const playerList = Object.values(round.players).map(p => ({ userId: p.userId, username: p.username }));
    return {
        round: {
            id: round.id, phase: round.phase, deadline: round.deadline || null,
            players: playerList, playerCount: Object.keys(round.players).length,
            submissions: round.phase === 'voting' || round.phase === 'revealed'
                ? Object.values(round.players).map(p => ({ word: p.word, userId: p.userId })) : null,
            impostorId: round.phase === 'revealed' ? round.impostorId : null,
            winner: round.phase === 'revealed' ? round.winner : null,
            votes: round.phase === 'revealed' ? round.votes : null, createdAt: round.createdAt
        }
    };
}
// Badge definitions
const BADGE_THRESHOLDS = [
    { key: 'first_win', check: (jp) => jp.wins >= 1 },
    { key: 'sharp_shooter', check: (jp) => jp.bestRank === 1 },
    { key: 'undercover', check: (_, imp) => imp.impostorAssignments >= 1 },
    { key: 'champion', check: (jp) => jp.wins >= 5 },
    { key: 'legend', check: (jp) => jp.wins >= 10 },
    { key: 'gambler', check: (jp) => jp.totalBets >= 20 },
    { key: 'master_impostor', check: (_, imp) => imp.impostorWins >= 3 },
    { key: 'top3_10', check: (jp) => jp.top3Count >= 10 },
    { key: 'hot_streak', check: (_, __, streak) => streak >= 3 },
    { key: 'meme_winner', check: (_, __, ___, meme) => (meme?.memeWins || 0) >= 1 },
];
const notifiedBadges = new Set();
function getUserBadges(userId) {
    const jpStats = db.getUserStats(userId);
    const impStats = db.getImpostorStats(userId);
    const memeStats = db.getMemeStats(userId);
    let streak = 0;
    for (const g of jpStats.gameHistory.slice().reverse()) {
        if (g.rank === 1)
            streak++;
        else
            break;
    }
    return BADGE_THRESHOLDS.filter(t => t.check(jpStats, impStats, streak, memeStats)).map(t => t.key);
}
function checkAndEmitBadges(userId) {
    const badges = getUserBadges(userId);
    const unlocked = [];
    for (const b of badges) {
        const key = `${userId}_${b}`;
        if (!notifiedBadges.has(key)) {
            notifiedBadges.add(key);
            unlocked.push(b);
        }
    }
    if (unlocked.length > 0)
        emitToUser(userId, 'badgeUnlocked', { badges: unlocked });
}
// Emit socket count periodically
setInterval(() => {
    const count = io.engine.clientsCount;
    io.emit('socketCount', count);
}, 5000);
// --- Routes ---
app.get('/login', (req, res) => {
    if (req.session.user)
        return res.redirect('/games');
    res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds`);
});
app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code)
        return res.redirect('/login');
    try {
        const tokenRes = await axios_1.default.post('https://discord.com/api/oauth2/token', new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const userRes = await axios_1.default.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
        const discordUser = userRes.data;
        if (GUILD_ID) {
            const guildsRes = await axios_1.default.get('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
            if (!guildsRes.data.some((g) => g.id === GUILD_ID))
                return res.render('not-member');
        }
        const u = db.upsertUser({
            id: discordUser.id, username: discordUser.username, globalName: discordUser.global_name || discordUser.username,
            avatar: discordUser.avatar, discriminator: discordUser.discriminator,
            isAdmin: ADMINS.includes(discordUser.username.toLowerCase())
        });
        req.session.user = { id: u.id, username: u.username, globalName: u.globalName, avatar: u.avatar, isAdmin: u.isAdmin };
        logger_1.default.info({ userId: u.id, username: u.username }, 'User logged in');
        req.session.save(() => res.redirect('/games'));
    }
    catch (err) {
        logger_1.default.error({ err: err.response?.data || err.message }, 'OAuth callback error');
        res.send(res.locals.t('errors.auth'));
    }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
// --- Pages ---
app.get('/', (req, res) => { if (req.session.user)
    return res.redirect('/games'); res.render('index'); });
app.get('/games', requireAuth, (req, res) => res.render('games', { user: req.session.user }));
app.get('/game', requireAuth, (req, res) => res.render('game', { user: req.session.user, isAdmin: req.session.user.isAdmin, ADMINS }));
app.get('/admin', requireAuth, requireAdmin, (req, res) => res.render('admin', { user: req.session.user, ADMINS }));
app.get('/admin/questions', requireAuth, requireAdmin, (req, res) => res.render('admin-questions', { user: req.session.user, ADMINS }));
app.get('/impostor', requireAuth, (req, res) => res.render('impostor', { user: req.session.user }));
app.get('/admin/impostor', requireAuth, requireAdmin, (req, res) => res.render('admin-impostor', { user: req.session.user }));
app.get('/admin/words', requireAuth, requireAdmin, (req, res) => res.render('admin-words', { user: req.session.user }));
app.get('/leaderboard', requireAuth, (req, res) => res.render('leaderboard', { user: req.session.user }));
app.get('/meme', requireAuth, (req, res) => res.render('meme', { user: req.session.user }));
app.get('/admin/meme', requireAuth, requireAdmin, (req, res) => res.render('admin-meme', { user: req.session.user }));
app.get('/profile', requireAuth, (req, res, next) => {
    try {
        const userId = req.session.user.id;
        const jpStats = db.getUserStats(userId);
        const impStats = db.getImpostorStats(userId);
        const memeStats = db.getMemeStats(userId);
        const impHistory = db.getImpostorGameHistory(userId);
        // Compute win streak (consecutive 1st places from most recent)
        let winStreak = 0;
        for (const g of jpStats.gameHistory.slice().reverse()) {
            if (g.rank === 1)
                winStreak++;
            else
                break;
        }
        const badges = [];
        if (jpStats.wins >= 1)
            badges.push('first_win');
        if (jpStats.bestRank === 1)
            badges.push('sharp_shooter');
        if (impStats.impostorAssignments >= 1)
            badges.push('undercover');
        if (jpStats.wins >= 5)
            badges.push('champion');
        if (jpStats.wins >= 10)
            badges.push('legend');
        if (jpStats.totalBets >= 20)
            badges.push('gambler');
        if (impStats.impostorWins >= 3)
            badges.push('master_impostor');
        if (jpStats.top3Count >= 10)
            badges.push('top3_10');
        if (winStreak >= 3)
            badges.push('hot_streak');
        if (memeStats.memeWins >= 1)
            badges.push('meme_winner');
        res.render('profile', { user: req.session.user, stats: { ...jpStats, ...impStats, ...memeStats, bestRank: jpStats.bestRank, top3Count: jpStats.top3Count, winStreak }, impHistory, badges });
    }
    catch (err) {
        next(err);
    }
});
// --- API ---
app.get('/api/state', (req, res) => {
    const state = buildGameState();
    const userAlreadyBet = req.session.user && state.bets.length > 0 && state.bets.some((b) => !b.anonymous && b.userId === req.session.user.id);
    res.json({ ...state, userAlreadyBet });
});
app.post('/api/bet', requireAuth, (req, res) => {
    const { value, reason } = req.body;
    if (value === undefined || value === null)
        throw new errors_1.ValidationError(res.locals.t('errors.value_required'));
    const num = parseFloat(value);
    if (isNaN(num))
        throw new errors_1.ValidationError(res.locals.t('errors.value_invalid'));
    const round = db.getCurrentRound();
    if (!round || round.revealed)
        throw new errors_1.ValidationError(res.locals.t('errors.no_round'));
    if (round.deadline && Date.now() >= round.deadline)
        throw new errors_1.ValidationError(res.locals.t('errors.time_up'));
    if (round.bets.find(b => b.userId === req.session.user.id))
        throw new errors_1.ValidationError(res.locals.t('errors.already_bet'));
    db.addBet(round.id, { userId: req.session.user.id, username: req.session.user.globalName || req.session.user.username, avatar: req.session.user.avatar, value: num, reason: reason ? sanitize(reason) : null, time: Date.now() });
    io.emit('betUpdate', { roundId: round.id, count: round.bets.length + 1 });
    io.emit('stateUpdate', buildGameState());
    res.json({ success: true, count: round.bets.length + 1 });
});
// --- Admin API ---
app.post('/api/admin/question', requireAuth, requireAdmin, (req, res) => {
    const { question, answer, reason, contextImg, duration } = req.body;
    if (!question || answer === undefined)
        throw new errors_1.ValidationError(res.locals.t('errors.question_required'));
    let deadline = null, revealed = false;
    if (duration !== 0 && duration)
        deadline = Date.now() + duration * 3600 * 1000;
    else
        revealed = true;
    const round = db.createRound({
        id: Date.now(), question: sanitize(question), answer: parseFloat(answer),
        reason: reason ? sanitize(reason) : null, contextImg: contextImg ? sanitize(contextImg) : null,
        revealed, deadline, createdBy: req.session.user.username, createdAt: new Date().toISOString()
    });
    io.emit('newRound', { id: round.id, question: round.question, deadline: round.deadline, revealed: round.revealed });
    io.emit('stateUpdate', buildGameState());
    res.json({ success: true, round: { id: round.id, question } });
});
app.post('/api/admin/reveal', requireAuth, requireAdmin, (req, res) => {
    const round = db.getCurrentRound();
    if (!round)
        throw new errors_1.ValidationError(res.locals.t('errors.no_round_found'));
    db.updateRound(round.id, { revealed: 1 });
    io.emit('roundRevealed', { id: round.id, answer: round.answer, reason: round.reason });
    io.emit('stateUpdate', buildGameState());
    // Check badges for all participants
    for (const b of (round.bets || []))
        checkAndEmitBadges(b.userId);
    res.json({ success: true });
});
app.get('/api/admin/history', requireAuth, requireAdmin, (req, res) => {
    res.json(db.getLastRoundIds(20));
});
// --- Questions bank ---
app.get('/api/admin/questions', requireAuth, requireAdmin, (req, res) => res.json(db.getAllQuestions()));
app.post('/api/admin/questions', requireAuth, requireAdmin, (req, res) => {
    const { q, a, r } = req.body;
    if (!q || a === undefined)
        throw new errors_1.ValidationError('Question (q) et réponse (a) requises');
    const qObj = typeof q === 'object' && q.fr ? { fr: sanitize(q.fr), en: sanitize(q.en || ''), ar: sanitize(q.ar || '') } : { fr: sanitize(q), en: '', ar: '' };
    const rObj = typeof r === 'object' ? { fr: sanitize(r.fr || ''), en: sanitize(r.en || ''), ar: sanitize(r.ar || '') } : { fr: sanitize(r || ''), en: '', ar: '' };
    db.addQuestion({ q: qObj, a: parseFloat(a), r: rObj });
    res.json({ success: true });
});
app.put('/api/admin/questions', requireAuth, requireAdmin, (req, res) => {
    const { id, q, a, r } = req.body;
    if (!id || !q || a === undefined)
        throw new errors_1.ValidationError('id, q, a requis');
    const qObj = typeof q === 'object' && q.fr ? { fr: sanitize(q.fr), en: sanitize(q.en || ''), ar: sanitize(q.ar || '') } : { fr: sanitize(q), en: '', ar: '' };
    const rObj = typeof r === 'object' ? { fr: sanitize(r.fr || ''), en: sanitize(r.en || ''), ar: sanitize(r.ar || '') } : { fr: sanitize(r || ''), en: '', ar: '' };
    db.updateQuestion(parseInt(id, 10), { q: qObj, a: parseFloat(a), r: rObj });
    res.json({ success: true });
});
app.delete('/api/admin/questions/:id', requireAuth, requireAdmin, (req, res) => {
    db.deleteQuestion(parseInt(String(req.params.id), 10));
    res.json({ success: true });
});
app.get('/api/admin/random-question', requireAuth, requireAdmin, (req, res) => {
    res.json(db.getRandomQuestion(res.locals.lang || 'fr'));
});
// --- Leaderboard ---
app.get('/api/leaderboard', (req, res) => {
    res.json(db.getLeaderboard(req.query.type || 'global'));
});
// --- Impostor API ---
app.get('/api/impostor/state', requireAuth, (req, res) => {
    const round = db.getImpostorState();
    if (!round)
        return res.json({ round: null });
    const userId = req.session.user.id;
    const player = round.players[userId];
    const playerList = Object.values(round.players).map(p => ({ userId: p.userId, username: p.username }));
    res.json({
        round: {
            id: round.id, phase: round.phase, deadline: round.deadline || null,
            realWord: round.phase === 'submission' && player ? (player.isImpostor ? round.fakeWord : round.realWord) : null,
            players: playerList, playerCount: Object.keys(round.players).length,
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
    if (!round || round.phase !== 'submission')
        return res.json({ success: true });
    if (!round.players[req.session.user.id]) {
        db.upsertImpostorPlayer(round.id, {
            userId: req.session.user.id, username: req.session.user.globalName || req.session.user.username,
            avatar: req.session.user.avatar, isImpostor: false, word: '', vote: ''
        });
    }
    io.emit('impostorPlayerJoined', { count: Object.keys(db.getImpostorState().players).length });
    io.emit('impostorStateUpdate', buildImpostorState());
    res.json({ success: true });
});
app.post('/api/impostor/submit', requireAuth, (req, res) => {
    const { word } = req.body;
    if (!word || !word.trim())
        throw new errors_1.ValidationError(res.locals.t('impostor.word_required'));
    const round = db.getImpostorState();
    if (!round || round.phase !== 'submission')
        throw new errors_1.ValidationError(res.locals.t('impostor.not_submission_phase'));
    const player = round.players[req.session.user.id];
    if (!player)
        throw new errors_1.ValidationError(res.locals.t('impostor.join_first'));
    if (player.word)
        throw new errors_1.ValidationError(res.locals.t('impostor.already_submitted'));
    db.upsertImpostorPlayer(round.id, { ...player, word: sanitize(word) });
    io.emit('impostorWordSubmitted', { id: round.id, playerId: req.session.user.id });
    io.emit('impostorStateUpdate', buildImpostorState());
    // Auto-transition to voting if all players have submitted
    const updated = db.getImpostorState();
    if (updated && updated.phase === 'submission') {
        const allSubmitted = Object.values(updated.players).every(p => p.word);
        if (allSubmitted && Object.keys(updated.players).length >= 2) {
            db.updateImpostorRound(round.id, { phase: 'voting' });
            io.emit('impostorVoting', { id: round.id });
            io.emit('impostorStateUpdate', buildImpostorState());
        }
    }
    res.json({ success: true });
});
app.post('/api/impostor/vote', requireAuth, (req, res) => {
    const { targetId } = req.body;
    if (!targetId)
        throw new errors_1.ValidationError(res.locals.t('impostor.vote_required'));
    const round = db.getImpostorState();
    if (!round || round.phase !== 'voting')
        throw new errors_1.ValidationError(res.locals.t('impostor.not_voting_phase'));
    const player = round.players[req.session.user.id];
    if (!player)
        throw new errors_1.ValidationError(res.locals.t('impostor.join_first'));
    if (player.vote)
        throw new errors_1.ValidationError(res.locals.t('impostor.already_voted'));
    if (!round.players[targetId])
        throw new errors_1.ValidationError(res.locals.t('impostor.invalid_target'));
    if (targetId === req.session.user.id)
        throw new errors_1.ValidationError(res.locals.t('impostor.cannot_self_vote'));
    db.upsertImpostorPlayer(round.id, { ...player, vote: targetId });
    io.emit('impostorVoteCast', { id: round.id, playerId: req.session.user.id });
    io.emit('impostorStateUpdate', buildImpostorState());
    res.json({ success: true });
});
// --- Admin Impostor API ---
app.get('/api/admin/impostor-words', requireAuth, requireAdmin, (req, res) => res.json(db.getAllWordsWithId()));
app.post('/api/admin/impostor-words', requireAuth, requireAdmin, (req, res) => {
    const { real, fake } = req.body;
    if (!real || !fake)
        throw new errors_1.ValidationError('Mots requis');
    const realObj = typeof real === 'object' ? { fr: sanitize(real.fr || ''), en: sanitize(real.en || ''), ar: sanitize(real.ar || '') } : { fr: sanitize(real), en: '', ar: '' };
    const fakeObj = typeof fake === 'object' ? { fr: sanitize(fake.fr || ''), en: sanitize(fake.en || ''), ar: sanitize(fake.ar || '') } : { fr: sanitize(fake), en: '', ar: '' };
    db.addWord({ real: realObj, fake: fakeObj });
    res.json({ success: true });
});
app.put('/api/admin/impostor-words', requireAuth, requireAdmin, (req, res) => {
    const { id, real, fake } = req.body;
    if (!id || !real || !fake)
        throw new errors_1.ValidationError('id, real, fake requis');
    const realObj = typeof real === 'object' ? { fr: sanitize(real.fr || ''), en: sanitize(real.en || ''), ar: sanitize(real.ar || '') } : { fr: sanitize(real), en: '', ar: '' };
    const fakeObj = typeof fake === 'object' ? { fr: sanitize(fake.fr || ''), en: sanitize(fake.en || ''), ar: sanitize(fake.ar || '') } : { fr: sanitize(fake), en: '', ar: '' };
    db.updateWord(parseInt(id, 10), { real: realObj, fake: fakeObj });
    res.json({ success: true });
});
app.delete('/api/admin/impostor-words/:id', requireAuth, requireAdmin, (req, res) => {
    db.deleteWord(parseInt(String(req.params.id), 10));
    res.json({ success: true });
});
app.get('/api/admin/impostor/history', requireAuth, requireAdmin, (req, res) => res.json(db.getLastImpostorRoundIds(10)));
app.post('/api/admin/impostor/start', requireAuth, requireAdmin, (req, res) => {
    const { realWord, fakeWord, duration } = req.body;
    if (!realWord || !fakeWord)
        throw new errors_1.ValidationError(res.locals.t('impostor.words_required'));
    const deadline = duration ? Date.now() + duration * 60 * 1000 : null;
    db.createImpostorRound({
        id: Date.now(), realWord: sanitize(realWord), fakeWord: sanitize(fakeWord),
        deadline, createdBy: req.session.user.username, createdAt: new Date().toISOString()
    });
    io.emit('impostorStart', { id: Date.now() });
    io.emit('impostorStateUpdate', buildImpostorState());
    res.json({ success: true });
});
app.post('/api/admin/impostor/start-random', requireAuth, requireAdmin, (req, res) => {
    const lang = res.locals.lang || 'fr';
    const { duration } = req.body;
    const pair = db.getRandomWord(lang);
    if (!pair)
        throw new errors_1.ValidationError(res.locals.t('impostor.no_words'));
    const deadline = duration ? Date.now() + duration * 60 * 1000 : null;
    db.createImpostorRound({
        id: Date.now(), realWord: pair.real, fakeWord: pair.fake,
        deadline, createdBy: req.session.user.username, createdAt: new Date().toISOString()
    });
    io.emit('impostorStart', { id: Date.now() });
    io.emit('impostorStateUpdate', buildImpostorState());
    res.json({ success: true, realWord: pair.real, fakeWord: pair.fake });
});
app.post('/api/admin/impostor/assign', requireAuth, requireAdmin, (req, res) => {
    const { targetId } = req.body;
    const round = db.getImpostorState();
    if (!round || round.phase !== 'submission')
        throw new errors_1.ValidationError(res.locals.t('impostor.no_round'));
    const playerIds = Object.keys(round.players);
    if (playerIds.length < 3)
        throw new errors_1.ValidationError(res.locals.t('impostor.need_min_players'));
    for (const pid of playerIds)
        db.upsertImpostorPlayer(round.id, { ...round.players[pid], isImpostor: false });
    const impostorId = targetId || playerIds[Math.floor(Math.random() * playerIds.length)];
    db.upsertImpostorPlayer(round.id, { ...round.players[impostorId], isImpostor: true });
    db.updateImpostorRound(round.id, { impostorId });
    io.emit('impostorAssign', { id: round.id });
    io.emit('impostorStateUpdate', buildImpostorState());
    res.json({ success: true, impostorId });
});
app.post('/api/admin/impostor/voting-phase', requireAuth, requireAdmin, (req, res) => {
    const round = db.getImpostorState();
    if (!round || round.phase !== 'submission')
        throw new errors_1.ValidationError(res.locals.t('impostor.no_round'));
    db.updateImpostorRound(round.id, { phase: 'voting' });
    io.emit('impostorVoting', { id: round.id });
    io.emit('impostorStateUpdate', buildImpostorState());
    res.json({ success: true });
});
app.post('/api/admin/impostor/reveal', requireAuth, requireAdmin, (req, res) => {
    const round = db.getImpostorState();
    if (!round || round.phase !== 'voting')
        throw new errors_1.ValidationError(res.locals.t('impostor.no_round'));
    const impostorId = round.impostorId;
    const votes = {};
    Object.values(round.players).forEach(p => { if (p.vote)
        votes[p.vote] = (votes[p.vote] || 0) + 1; });
    const impostorVotes = votes[impostorId] || 0;
    const totalVoters = Object.values(round.players).filter(p => p.vote).length;
    const majority = totalVoters > 0 && impostorVotes > totalVoters / 2;
    const winner = majority ? 'players' : 'impostor';
    db.updateImpostorRound(round.id, { phase: 'revealed', winner });
    for (const pid of Object.keys(round.players)) {
        const pts = winner === 'impostor' && pid === impostorId ? 3 : (winner === 'players' && pid !== impostorId ? 1 : 0);
        if (pts)
            db.addImpostorPoints(round.id, pid, pts);
    }
    io.emit('impostorRevealed', { id: round.id, winner });
    io.emit('impostorStateUpdate', buildImpostorState());
    for (const pid of Object.keys(round.players))
        checkAndEmitBadges(pid);
    res.json({ success: true, winner });
});
// --- Meme Royale API ---
app.get('/api/meme/state', requireAuth, (req, res) => {
    const state = db.getMemeState();
    if (!state.round)
        return res.json({ round: null, submissions: [], votes: {} });
    const userId = req.session.user.id;
    const sub = state.submissions.find(s => s.userId === userId);
    res.json({
        round: { id: state.round.id, theme: state.round.theme, phase: state.round.phase, deadline: state.round.deadline || null, winnerId: state.round.phase === 'revealed' ? state.round.winnerId : null },
        submissions: state.round.phase === 'voting' || state.round.phase === 'revealed'
            ? state.submissions.map(s => state.round.phase === 'revealed' ? s : { gifUrl: s.gifUrl, gifPreview: s.gifPreview, gifTitle: s.gifTitle, userId: s.userId })
            : [],
        votes: state.round.phase === 'revealed' ? state.votes : {},
        iSubmitted: !!sub,
        iVoted: db.hasMemeVoted(state.round.id, userId)
    });
});
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || 'KEPrZtPxrhx1q5xGMkoptzhoHDAtcgGs';
app.get('/api/meme/search', requireAuth, async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q)
        return res.json({ results: [] });
    try {
        const gres = await axios_1.default.get('https://api.giphy.com/v1/gifs/search', {
            params: { api_key: GIPHY_API_KEY, q, limit: 20, rating: 'pg' }
        });
        const results = (gres.data.data || []).map((g) => ({
            id: g.id, title: g.title,
            url: g.images?.original?.url || '',
            preview: g.images?.fixed_height?.url || g.images?.original?.url || ''
        }));
        res.json({ results });
    }
    catch (err) {
        logger_1.default.error({ err: err.message }, 'GIPHY search error');
        res.json({ results: [] });
    }
});
app.post('/api/meme/submit', requireAuth, (req, res) => {
    const { gifUrl, gifPreview, gifTitle } = req.body;
    if (!gifUrl)
        throw new errors_1.ValidationError(res.locals.t('meme.gif_required'));
    const state = db.getMemeState();
    if (!state.round || state.round.phase !== 'submission')
        throw new errors_1.ValidationError(res.locals.t('meme.no_round'));
    const userId = req.session.user.id;
    if (db.memeSubmissionExists(state.round.id, userId))
        throw new errors_1.ValidationError(res.locals.t('meme.already_submitted'));
    db.upsertMemeSubmission(state.round.id, {
        userId, username: req.session.user.globalName || req.session.user.username,
        avatar: req.session.user.avatar, gifUrl: sanitize(gifUrl), gifPreview: sanitize(gifPreview || gifUrl), gifTitle: sanitize(gifTitle || '')
    });
    io.emit('memeSubmitted', { roundId: state.round.id, count: state.submissions.length + 1 });
    res.json({ success: true });
});
app.post('/api/meme/vote', requireAuth, (req, res) => {
    const { targetId } = req.body;
    if (!targetId)
        throw new errors_1.ValidationError(res.locals.t('meme.vote_required'));
    const state = db.getMemeState();
    if (!state.round || state.round.phase !== 'voting')
        throw new errors_1.ValidationError(res.locals.t('meme.not_voting'));
    const userId = req.session.user.id;
    if (db.hasMemeVoted(state.round.id, userId))
        throw new errors_1.ValidationError(res.locals.t('meme.already_voted'));
    if (targetId === userId)
        throw new errors_1.ValidationError(res.locals.t('meme.cannot_self_vote'));
    if (!state.submissions.some(s => s.userId === targetId))
        throw new errors_1.ValidationError(res.locals.t('meme.invalid_target'));
    db.addMemeVote(state.round.id, userId, targetId);
    io.emit('memeVoteCast', { roundId: state.round.id });
    res.json({ success: true });
});
// Admin meme
app.post('/api/admin/meme/start', requireAuth, requireAdmin, (req, res) => {
    const { theme, duration } = req.body;
    if (!theme || !theme.trim())
        throw new errors_1.ValidationError(res.locals.t('meme.theme_required'));
    const deadline = duration ? Date.now() + duration * 60 * 1000 : null;
    db.createMemeRound({ id: Date.now(), theme: sanitize(theme), deadline, createdBy: req.session.user.username, createdAt: new Date().toISOString() });
    io.emit('memeStart', { theme });
    res.json({ success: true });
});
app.post('/api/admin/meme/voting', requireAuth, requireAdmin, (req, res) => {
    const state = db.getMemeState();
    if (!state.round || state.round.phase !== 'submission')
        throw new errors_1.ValidationError(res.locals.t('meme.no_round'));
    if (state.submissions.length < 2)
        throw new errors_1.ValidationError(res.locals.t('meme.need_min_submissions'));
    db.updateMemeRound(state.round.id, { phase: 'voting' });
    io.emit('memeVoting', {});
    res.json({ success: true });
});
app.post('/api/admin/meme/cancel', requireAuth, requireAdmin, (_req, res) => {
    const state = db.getMemeState();
    if (state.round) {
        db.updateMemeRound(state.round.id, { phase: 'cancelled' });
        io.emit('memeCancelled', {});
    }
    res.json({ success: true });
});
app.post('/api/admin/meme/reveal', requireAuth, requireAdmin, (req, res) => {
    const state = db.getMemeState();
    if (!state.round || state.round.phase !== 'voting')
        throw new errors_1.ValidationError(res.locals.t('meme.no_round'));
    const vc = db.getMemeVoteCounts(state.round.id);
    const sorted = Object.entries(vc).sort((a, b) => b[1] - a[1]);
    const winnerId = sorted.length > 0 ? sorted[0][0] : '';
    const top3 = sorted.slice(0, 3);
    top3.forEach(([uid], idx) => {
        const pts = idx === 0 ? 3 : idx === 1 ? 2 : 1;
        if (pts)
            db.addMemePoints(state.round.id, uid, pts);
    });
    db.updateMemeRound(state.round.id, { phase: 'revealed', winnerId });
    io.emit('memeRevealed', { winnerId });
    for (const sub of state.submissions)
        checkAndEmitBadges(sub.userId);
    res.json({ success: true, winnerId, voteCounts: vc });
});
// --- Error handler (last) ---
app.use(errorHandler);
// --- Cron: auto-reveal every 10s ---
node_cron_1.default.schedule('*/10 * * * * *', () => {
    // Juste Prix auto-reveal
    const round = db.getCurrentRound();
    if (round && !round.revealed && round.deadline && Date.now() >= round.deadline) {
        db.updateRound(round.id, { revealed: 1 });
        io.emit('roundRevealed', { id: round.id, answer: round.answer, reason: round.reason });
        io.emit('stateUpdate', buildGameState());
        for (const b of (round.bets || []))
            checkAndEmitBadges(b.userId);
        logger_1.default.info({ roundId: round.id }, 'Auto-revealed Juste Prix round via cron');
    }
    // Impostor auto-transition: submission -> voting if deadline passed
    const imp = db.getImpostorState();
    if (imp && imp.phase === 'submission' && imp.deadline && Date.now() >= imp.deadline) {
        if (imp.impostorId) {
            db.updateImpostorRound(imp.id, { phase: 'voting' });
            io.emit('impostorVoting', { id: imp.id });
            io.emit('impostorStateUpdate', buildImpostorState());
            logger_1.default.info({ roundId: imp.id }, 'Auto-transitioned impostor to voting via cron');
        }
    }
    // Impostor auto-reveal if voting phase deadline passed
    if (imp && imp.phase === 'voting' && imp.deadline && Date.now() >= imp.deadline) {
        const impostorId = imp.impostorId;
        const votes = {};
        Object.values(imp.players).forEach(p => { if (p.vote)
            votes[p.vote] = (votes[p.vote] || 0) + 1; });
        const impostorVotes = votes[impostorId] || 0;
        const totalVoters = Object.values(imp.players).filter(p => p.vote).length;
        const majority = totalVoters > 0 && impostorVotes > totalVoters / 2;
        const winner = majority ? 'players' : 'impostor';
        db.updateImpostorRound(imp.id, { phase: 'revealed', winner });
        for (const pid of Object.keys(imp.players)) {
            const pts = winner === 'impostor' && pid === impostorId ? 3 : (winner === 'players' && pid !== impostorId ? 1 : 0);
            if (pts)
                db.addImpostorPoints(imp.id, pid, pts);
        }
        io.emit('impostorRevealed', { id: imp.id, winner });
        io.emit('impostorStateUpdate', buildImpostorState());
        for (const pid of Object.keys(imp.players))
            checkAndEmitBadges(pid);
        logger_1.default.info({ roundId: imp.id, winner }, 'Auto-revealed impostor round via cron');
    }
    // Meme auto-reveal: submission -> voting if deadline passed
    const meme = db.getMemeState();
    if (meme.round && meme.round.phase === 'submission' && meme.round.deadline && Date.now() >= meme.round.deadline) {
        if (meme.submissions.length >= 2) {
            db.updateMemeRound(meme.round.id, { phase: 'voting' });
            io.emit('memeVoting', {});
            logger_1.default.info({ roundId: meme.round.id }, 'Auto-transitioned meme to voting via cron');
        }
    }
    // Meme auto-reveal if voting deadline passed
    if (meme.round && meme.round.phase === 'voting' && meme.round.deadline && Date.now() >= meme.round.deadline) {
        const vc = db.getMemeVoteCounts(meme.round.id);
        const sorted = Object.entries(vc).sort((a, b) => b[1] - a[1]);
        const winnerId = sorted.length > 0 ? sorted[0][0] : '';
        const top3 = sorted.slice(0, 3);
        top3.forEach(([uid], idx) => {
            const pts = idx === 0 ? 3 : idx === 1 ? 2 : 1;
            if (pts)
                db.addMemePoints(meme.round.id, uid, pts);
        });
        db.updateMemeRound(meme.round.id, { phase: 'revealed', winnerId });
        io.emit('memeRevealed', { winnerId });
        for (const sub of meme.submissions)
            checkAndEmitBadges(sub.userId);
        logger_1.default.info({ roundId: meme.round.id, winnerId }, 'Auto-revealed meme round via cron');
    }
});
// --- Graceful shutdown ---
function shutdown(signal) {
    logger_1.default.info({ signal }, 'Shutting down gracefully');
    io.close(() => logger_1.default.info('Socket.io closed'));
    server.close(() => {
        db.save();
        logger_1.default.info('Server closed');
        process.exit(0);
    });
    setTimeout(() => { logger_1.default.error('Forced shutdown after timeout'); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// --- Start ---
async function main() {
    await db.init();
    server.listen(PORT, () => {
        logger_1.default.info({ port: PORT, admins: ADMINS }, 'UAC Game server started');
    });
}
if (require.main === module) {
    main();
}
else {
    module.exports = app;
    const ready = db.init();
    module.exports._ready = ready;
}
//# sourceMappingURL=server.js.map