import { Request, Response, NextFunction } from 'express';
declare function loadLocale(lang: string): unknown;
declare function t(locale: unknown): (key: string, data?: Record<string, string | number>) => string;
declare function i18nMiddleware(req: Request, res: Response, next: NextFunction): void;
export { i18nMiddleware, loadLocale, t };
//# sourceMappingURL=i18n.d.ts.map