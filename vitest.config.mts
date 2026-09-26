import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Two projects under one config, so a plain `npx vitest run` (or `npm test`,
// which just runs `vitest run`) covers both:
//   - node: the server and plain web/src/lib unit tests, as before.
//   - components: Svelte 5 component tests (fix round 1, items 1-4), which
//     need the Svelte Vite plugin (to compile .svelte imports) and the
//     browser build of Svelte (resolve.conditions: ['browser']) -- the
//     default Node build doesn't wire up $effect/$state against a real DOM
//     the way jsdom needs for these tests to behave like the app does.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['test/**/*.test.ts', 'web/src/**/*.test.ts'],
          exclude: ['web/src/components/**/*.test.ts'],
          setupFiles: ['./test/setup.ts'],
          env: { LOG_LEVEL: 'silent', DOWNLOAD_RETRY_DELAY_MS: '20', TZ: 'America/Chicago' },
        },
      },
      {
        plugins: [svelte()],
        resolve: { conditions: ['browser'] },
        test: {
          name: 'components',
          environment: 'jsdom',
          include: ['web/src/components/*.test.ts'],
          setupFiles: ['./test/setupComponents.ts'],
          env: { TZ: 'America/Chicago' },
        },
      },
    ],
  },
});
