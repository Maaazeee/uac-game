"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.i18nMiddleware = i18nMiddleware;
exports.loadLocale = loadLocale;
exports.t = t;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const PROJECT_ROOT = fs_1.default.existsSync(path_1.default.join(__dirname, 'locales')) ? __dirname : path_1.default.join(__dirname, '..');
const LOCALES_DIR = path_1.default.join(PROJECT_ROOT, 'locales');
const cache = {};
function loadLocale(lang) {
    if (cache[lang])
        return cache[lang];
    try {
        const file = path_1.default.join(LOCALES_DIR, `${lang}.json`);
        cache[lang] = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
        return cache[lang];
    }
    catch {
        return loadLocale('fr');
    }
}
function t(locale) {
    return function (key, data) {
        const keys = key.split('.');
        let val = locale;
        for (const k of keys) {
            if (val && typeof val === 'object' && k in val)
                val = val[k];
            else
                return key;
        }
        if (typeof val !== 'string')
            return key;
        if (data) {
            return val.replace(/\{\{(\w+)\}\}/g, (_, k) => data[k] !== undefined ? String(data[k]) : `{{${k}}}`);
        }
        return val;
    };
}
function i18nMiddleware(req, res, next) {
    let lang = req.query.lang || req.cookies?.lang || 'fr';
    if (!['fr', 'en', 'ar'].includes(lang))
        lang = 'fr';
    const locale = loadLocale(lang);
    res.locals.lang = lang;
    res.locals.dir = locale.dir || 'ltr';
    res.locals.t = t(locale);
    res.locals.locale = locale;
    if (req.query.lang && req.cookies?.lang !== lang) {
        res.cookie('lang', lang, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: false });
    }
    next();
}
//# sourceMappingURL=i18n.js.map