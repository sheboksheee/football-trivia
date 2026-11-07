import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: '@ft/server', include: ['test/**/*.test.ts'], passWithNoTests: true, testTimeout: 20000 } });
