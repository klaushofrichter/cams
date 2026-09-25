import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'web/src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    env: { LOG_LEVEL: 'silent' },
  },
});
