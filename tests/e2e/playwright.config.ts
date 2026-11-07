import { defineConfig } from '@playwright/test';

const PORT = 8791;
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'off' },
  webServer: {
    // Built web app served by the real server; test-only timer scale keeps games short.
    command: `pnpm --filter @ft/web build && cd ../../apps/server && PORT=${PORT} WEB_DIST=../web/dist ADMIN_TOKEN=e2e-admin-token FT_TIME_SCALE=0.15 JOIN_RATE_PER_MINUTE=1000 LOG_LEVEL=warn npx tsx src/main.ts`,
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
