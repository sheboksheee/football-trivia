import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const prod = { NODE_ENV: 'production', SESSION_SECRET: 'a-real-secret-value' } as NodeJS.ProcessEnv;

describe('config', () => {
  it('production requires a database unless DEMO_MODE is explicitly on', () => {
    expect(() => loadConfig(prod)).toThrow(/DATABASE_URL/);
    const demo = loadConfig({ ...prod, DEMO_MODE: 'true' });
    expect(demo.DEMO_MODE).toBe(true);
    expect(demo.production).toBe(true);
  });
  it('production still refuses the default secret and test timer scaling, even in demo', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DEMO_MODE: 'true' } as NodeJS.ProcessEnv)).toThrow(
      /SESSION_SECRET/,
    );
    expect(() => loadConfig({ ...prod, DEMO_MODE: 'true', FT_TIME_SCALE: '0.5' })).toThrow(/FT_TIME_SCALE/);
  });
});
