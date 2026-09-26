import { createMockCamera } from './server';

// Started by Playwright (playwright.config.ts) for the e2e suite. The
// credentials match e2e/cameras.json; they are not real.
const port = Number(process.env.MOCK_CAMERA_PORT ?? 8098);
const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
createMockCamera({
  user: 'e2e',
  password: 'e2e-not-a-real-password',
  settingsFailures: list(process.env.MOCK_SETTINGS_FAILURES),
  ignoreWrites: list(process.env.MOCK_IGNORE_WRITES),
}).app.listen(port, () => {
  console.log(`mock camera listening on ${port}`);
});
