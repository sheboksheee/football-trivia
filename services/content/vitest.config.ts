import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: '@ft/content', include: ['test/**/*.test.ts'], passWithNoTests: true } });
