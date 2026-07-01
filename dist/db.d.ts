import { Database as SqlJsDatabase } from 'sql.js';
export interface User {
    id: string;
    username: string;
    globalName: string;
    avatar: string;
    discriminator: string;
    isAdmin: boolean;
    createdAt: string;
}
export interface Bet {
    userId: string;
    username: string;
    avatar: string;
    value: number;
    reason: string | null;
    time: number | null;
}
export interface Round {
    id: number;
    question: string;
    answer: number;
    reason: string;
    contextImg: string;
    revealed: boolean;
    deadline: number | null;
    createdBy: string;
    createdAt: string;
    bets: Bet[];
}
export interface ImpostorPlayer {
    userId: string;
    username: string;
    avatar: string;
    isImpostor: boolean;
    word: string;
    vote: string;
}
export interface ImpostorRound {
    id: number;
    realWord: string;
    fakeWord: string;
    impostorId: string;
    phase: string;
    winner: string;
    deadline: number | null;
    createdBy: string;
    createdAt: string;
    players: Record<string, ImpostorPlayer>;
    points: Record<string, number>;
    votes: Record<string, number>;
}
export interface LeaderboardEntry {
    userId: string;
    username: string;
    avatar: string;
    points: number;
    wins: number;
    bets: number;
    impostorGames?: number;
    impostorWins?: number;
}
export interface UserStats {
    totalBets: number;
    wins: number;
    points: number;
    bestRank: number | null;
    top3Count: number;
    gameHistory: Array<{
        question: string;
        value: number;
        answer: number;
        rank: number;
        total: number;
        createdAt: string;
    }>;
}
export interface ImpostorStats {
    impostorGames: number;
    impostorWins: number;
    impostorAssignments: number;
    impostorPoints: number;
}
declare function init(): Promise<SqlJsDatabase>;
declare function save(): void;
declare function getUser(id: string): User | null;
declare function upsertUser(u: {
    id: string;
    username: string;
    globalName: string;
    avatar: string;
    discriminator: string;
    isAdmin: boolean;
}): User | null;
declare function getBets(roundId: number): Bet[];
declare function getCurrentRound(): Round | null;
declare function getAllRounds(): Round[];
declare function createRound(data: {
    id: number;
    question: string;
    answer: number;
    reason: string;
    contextImg: string;
    revealed: boolean;
    deadline: number | null;
    createdBy: string;
    createdAt: string;
}): Round | null;
declare function updateRound(id: number, fields: Record<string, unknown>): void;
declare function addBet(roundId: number, bet: {
    userId: string;
    username: string;
    avatar: string;
    value: number;
    reason: string | null;
    time: number;
}): void;
declare function getImpostorPlayers(roundId: number): Record<string, ImpostorPlayer>;
declare function getImpostorPoints(roundId: number): Record<string, number>;
declare function getImpostorState(): ImpostorRound | null;
declare function createImpostorRound(data: {
    id: number;
    realWord: string;
    fakeWord: string;
    deadline: number | null;
    createdBy: string;
    createdAt: string;
}): ImpostorRound | null;
declare function updateImpostorRound(id: number, fields: Record<string, unknown>): void;
declare function upsertImpostorPlayer(roundId: number, player: ImpostorPlayer): void;
declare function addImpostorPoints(roundId: number, userId: string, points: number): void;
declare function getLeaderboard(type?: string): LeaderboardEntry[];
declare function getUserStats(userId: string): UserStats;
export interface ImpostorGameEntry {
    realWord: string;
    fakeWord: string;
    role: string;
    winner: string;
    points: number;
    impostorFound: boolean | null;
    createdAt: string;
}
declare function getImpostorGameHistory(userId: string): ImpostorGameEntry[];
declare function getImpostorStats(userId: string): ImpostorStats;
declare function getAllQuestions(): Array<{
    q: Record<string, string>;
    a: number;
    r: Record<string, string>;
}>;
declare function addQuestion(data: {
    q: Record<string, string>;
    a: number;
    r: Record<string, string>;
}): void;
declare function updateQuestion(id: number, data: {
    q: Record<string, string>;
    a: number;
    r: Record<string, string>;
}): void;
declare function deleteQuestion(id: number): void;
declare function getRandomQuestion(lang?: string): {
    q: string;
    a: number;
    r: string;
};
declare function getAllWordsWithId(): Array<{
    id: number;
    real: Record<string, string>;
    fake: Record<string, string>;
}>;
declare function getAllWords(): Array<{
    real: Record<string, string>;
    fake: Record<string, string>;
}>;
declare function addWord(data: {
    real: Record<string, string>;
    fake: Record<string, string>;
}): void;
declare function updateWord(id: number, data: {
    real: Record<string, string>;
    fake: Record<string, string>;
}): void;
declare function deleteWord(id: number): void;
declare function getRandomWord(lang?: string): {
    real: string;
    fake: string;
} | null;
declare function getLastRoundIds(count?: number): Record<string, unknown>[];
declare function getLastImpostorRoundIds(count?: number): Record<string, unknown>[];
export { init, save, getUser, upsertUser, getCurrentRound, getAllRounds, createRound, updateRound, addBet, getLastRoundIds, getImpostorState, createImpostorRound, updateImpostorRound, upsertImpostorPlayer, addImpostorPoints, getLastImpostorRoundIds, getLeaderboard, getUserStats, getImpostorStats, getImpostorGameHistory, getAllQuestions, addQuestion, updateQuestion, deleteQuestion, getRandomQuestion, getAllWords, getAllWordsWithId, addWord, updateWord, deleteWord, getRandomWord, getBets, getImpostorPlayers, getImpostorPoints };
//# sourceMappingURL=db.d.ts.map