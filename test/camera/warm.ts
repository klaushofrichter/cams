// Vitest global setup: builds cam-sim's test-pattern fixtures once, before
// the workers start, instead of in every worker's first test.
import { ensureFixtures, defaultFixtureDir } from 'cam-sim';
import pino from 'pino';

export default async function setup() {
  await ensureFixtures(defaultFixtureDir(), pino({ level: 'silent' }));
}
