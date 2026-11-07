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
});

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
