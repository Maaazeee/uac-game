const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, 'locales');
const cache = {};

function loadLocale(lang) {
  if (cache[lang]) return cache[lang];
  try {
    const file = path.join(LOCALES_DIR, `${lang}.json`);
    cache[lang] = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cache[lang];
  } catch {
    return loadLocale('fr');
  }
}

function t(locale) {
  return function (key, data) {
    const keys = key.split('.');
    let val = locale;
    for (const k of keys) {
      if (val && typeof val === 'object' && k in val) val = val[k];
      else return key;
    }
    if (typeof val !== 'string') return key;
    if (data) {
      return val.replace(/\{\{(\w+)\}\}/g, (_, k) => data[k] !== undefined ? data[k] : `{{${k}}}`);
    }
    return val;
  };
}

function i18nMiddleware(req, res, next) {
  let lang = req.query.lang || req.cookies?.lang || 'fr';
  if (!['fr', 'en', 'ar'].includes(lang)) lang = 'fr';
  const locale = loadLocale(lang);
  res.locals.lang = lang;
  res.locals.dir = locale.dir || 'ltr';
  res.locals.t = t(locale);
  res.locals.locale = locale;

  // Set cookie if changed via query
  if (req.query.lang && req.cookies?.lang !== lang) {
    res.cookie('lang', lang, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: false });
  }

  next();
}

module.exports = { i18nMiddleware, loadLocale, t };
