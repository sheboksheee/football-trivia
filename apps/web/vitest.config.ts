import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  test: {
    name: '@ft/web',
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    passWithNoTests: true,
  },
});
