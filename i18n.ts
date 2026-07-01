import fs from 'fs';
import path from 'path';
import { Request, Response, NextFunction } from 'express';

const PROJECT_ROOT = fs.existsSync(path.join(__dirname, 'locales')) ? __dirname : path.join(__dirname, '..');
const LOCALES_DIR = path.join(PROJECT_ROOT, 'locales');
const cache: Record<string, unknown> = {};

function loadLocale(lang: string): unknown {
  if (cache[lang]) return cache[lang];
  try {
    const file = path.join(LOCALES_DIR, `${lang}.json`);
    cache[lang] = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cache[lang];
  } catch {
    return loadLocale('fr');
  }
}

function t(locale: unknown) {
  return function (key: string, data?: Record<string, string | number>): string {
    const keys = key.split('.');
    let val: unknown = locale;
    for (const k of keys) {
      if (val && typeof val === 'object' && k in (val as Record<string, unknown>)) val = (val as Record<string, unknown>)[k];
      else return key;
    }
    if (typeof val !== 'string') return key;
    if (data) {
      return val.replace(/\{\{(\w+)\}\}/g, (_, k: string) => data[k] !== undefined ? String(data[k]) : `{{${k}}}`);
    }
    return val;
  };
}

function i18nMiddleware(req: Request, res: Response, next: NextFunction): void {
  let lang = (req.query.lang as string) || req.cookies?.lang || 'fr';
  if (!['fr', 'en', 'ar'].includes(lang)) lang = 'fr';
  const locale = loadLocale(lang) as Record<string, unknown>;
  res.locals.lang = lang;
  res.locals.dir = (locale.dir as string) || 'ltr';
  res.locals.t = t(locale);
  res.locals.locale = locale;
  if (req.query.lang && req.cookies?.lang !== lang) {
    res.cookie('lang', lang, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: false });
  }
  next();
}

export { i18nMiddleware, loadLocale, t };
