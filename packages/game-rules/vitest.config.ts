import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { name: '@ft/game-rules', include: ['test/**/*.test.ts'], passWithNoTests: true },
});
