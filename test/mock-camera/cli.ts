import { createMockCamera } from './server';

// Started by Playwright (playwright.config.ts) for the e2e suite. The
// credentials match e2e/cameras.json; they are not real.
const port = Number(process.env.MOCK_CAMERA_PORT ?? 8098);
createMockCamera({ user: 'e2e', password: 'e2e-not-a-real-password' }).app.listen(port, () => {
  console.log(`mock camera listening on ${port}`);
});
