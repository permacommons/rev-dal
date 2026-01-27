export interface DalLanguageProvider {
  getValidLanguagesAndUndetermined(): string[];
  getFallbacks(lang: string): string[];
}

export interface DalDebugLogger {
  db: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const DEFAULT_SUPPORTED_LOCALES = [
  'en',
  'ar',
  'bn',
  'de',
  'eo',
  'es',
  'fi',
  'fr',
  'hi',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'lt',
  'mk',
  'nl',
  'pl',
  'pt',
  'pt-PT',
  'ru',
  'sk',
  'sl',
  'sv',
  'tr',
  'uk',
  'ur',
  'zh',
  'zh-Hant',
] as const;

const buildFallbackMap = ({
  minimalFallback = false,
}: {
  minimalFallback?: boolean;
} = {}): Record<string, string[]> => {
  const scriptByLang: Partial<Record<string, string | null>> = {};
  const baseByLang: Partial<Record<string, string>> = {};

  const getBase = (code: string): string => {
    const cachedBase = baseByLang[code];
    if (cachedBase !== undefined) return cachedBase;
    try {
      baseByLang[code] = new Intl.Locale(code).language || code.toLowerCase();
    } catch {
      baseByLang[code] = code.toLowerCase();
    }
    return baseByLang[code] ?? code.toLowerCase();
  };

  const getScript = (code: string): string | null => {
    if (Object.hasOwn(scriptByLang, code)) {
      return scriptByLang[code] ?? null;
    }
    try {
      scriptByLang[code] = new Intl.Locale(code).maximize().script || null;
    } catch {
      scriptByLang[code] = null;
    }
    return scriptByLang[code] ?? null;
  };

  const supported = [...DEFAULT_SUPPORTED_LOCALES];
  const result: Record<string, string[]> = {};

  for (const lang of supported) {
    const fallbacks: string[] = [];
    const seen = new Set<string>();
    const append = (code?: string | null) => {
      if (!code) return;
      if (seen.has(code)) return;
      seen.add(code);
      fallbacks.push(code);
    };

    append(lang);
    append('und');

    const base = getBase(lang);
    for (const candidate of supported) {
      if (candidate === lang) continue;
      if (getBase(candidate) === base) append(candidate);
    }

    append('en');

    if (!minimalFallback) {
      const script = getScript(lang);
      if (script) {
        for (const candidate of supported) {
          if (seen.has(candidate)) continue;
          if (getScript(candidate) === script) append(candidate);
        }
      }

      for (const candidate of supported) append(candidate);
    }

    result[lang] = fallbacks;
  }

  return result;
};

const DEFAULT_FALLBACKS = ['en', 'und', ...DEFAULT_SUPPORTED_LOCALES].filter(
  (value, index, self) => self.indexOf(value) === index
) as string[];

const FALLBACKS_BY_LANG = buildFallbackMap();

const defaultLanguageProvider: DalLanguageProvider = {
  getValidLanguagesAndUndetermined(): string[] {
    return [...DEFAULT_SUPPORTED_LOCALES, 'und'];
  },
  getFallbacks(lang: string): string[] {
    return FALLBACKS_BY_LANG[lang] ?? DEFAULT_FALLBACKS;
  },
};

let languageProvider: DalLanguageProvider = defaultLanguageProvider;

let debugLogger: DalDebugLogger = {
  db: () => undefined,
  error: () => undefined,
};

export const debug = {
  db: (...args: unknown[]) => {
    debugLogger.db(...args);
  },
  error: (...args: unknown[]) => {
    debugLogger.error(...args);
  },
};

export const setLanguageProvider = (provider: DalLanguageProvider): void => {
  languageProvider = provider;
};

export const getLanguageProvider = (): DalLanguageProvider => languageProvider;

export const setDebugLogger = (logger: DalDebugLogger): void => {
  debugLogger = logger;
};
