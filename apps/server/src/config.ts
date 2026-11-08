import { z } from 'zod';

const Env = z.object({
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().optional(),
  SESSION_SECRET: z.string().min(8).default('dev-only-session-secret'),
  ADMIN_TOKEN: z.string().optional(),
  JOIN_RATE_PER_MINUTE: z.coerce.number().int().positive().default(10),
  SPECTATOR_SOFT_CAP: z.coerce.number().int().positive().default(500),
  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.string().default('development'),
  /** Scales all game timers. ONLY for automated E2E tests; refused in production. */
  FT_TIME_SCALE: z.coerce.number().positive().max(1).default(1),
  WEB_DIST: z.string().optional(),
  CONTENT_POLICY: z.enum(['DEV', 'STRICT']).optional(),
  /** Public demo: production hardening, but in-memory storage and the fictional DEV question bank. */
  DEMO_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** football-data.org token (server-side only). */
  FOOTBALL_DATA_API_KEY: z.string().optional(),
  /** Enable ingestion even without a token here (e.g. a proxy injects the X-Auth-Token header). */
  FOOTBALL_DATA_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /** Comma-separated competition codes. Defaults to the five big free-plan leagues. */
  FOOTBALL_DATA_COMPETITIONS: z.string().default('PL,PD,SA,BL1,FL1'),
  /** Comma-separated season start years. Defaults to the last three completed seasons + current. */
  FOOTBALL_DATA_SEASONS: z.string().optional(),
  /** Fetch automatically at boot when enabled. */
  FOOTBALL_DATA_AUTO_INGEST: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

/** Season start years: current season (started in August or later) plus the three before it. */
export function defaultSeasons(today = new Date()): number[] {
  const y = today.getUTCFullYear();
  const current = today.getUTCMonth() >= 6 ? y : y - 1;
  return [current - 3, current - 2, current - 1, current];
}

export function footballDataSettings(c: Config) {
  const enabled = !!c.FOOTBALL_DATA_API_KEY || !!c.FOOTBALL_DATA_ENABLED;
  const seasons = c.FOOTBALL_DATA_SEASONS
    ? c.FOOTBALL_DATA_SEASONS.split(',')
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isInteger(x) && x > 1900)
    : defaultSeasons();
  const competitions = c.FOOTBALL_DATA_COMPETITIONS.split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  return { enabled, token: c.FOOTBALL_DATA_API_KEY || undefined, competitions, seasons };
}

export type Config = z.infer<typeof Env> & { production: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = Env.parse(env);
  const production = c.NODE_ENV === 'production';
  if (production) {
    if (c.SESSION_SECRET === 'dev-only-session-secret')
      throw new Error('SESSION_SECRET must be set in production');
    if (c.FT_TIME_SCALE !== 1) throw new Error('FT_TIME_SCALE is test-only and must be 1 in production');
    if (!c.DATABASE_URL && !c.DEMO_MODE)
      throw new Error('DATABASE_URL is required in production (or set DEMO_MODE=true for a throwaway demo)');
  }
  return { ...c, production };
}
