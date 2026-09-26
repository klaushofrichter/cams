// The camera for cams' tests: cam-sim (github.com/klaushofrichter/cam-sim),
// behind the option names and state fields of the old in-repo mock, so the
// tests only changed where they create the camera.
import { createCamSim, DEMO_CLIPS, type CamSim, type FaultSpec, type SeedClip } from 'cam-sim';

export interface MockClip {
  daysAgo: number;
  start: string;
  end: string;
  triggers: ('person' | 'vehicle' | 'pet' | 'motion')[];
  mainEnd?: string;
}

export interface MockCameraOptions {
  user: string;
  password: string;
  firmware?: string;
  flvDelayMs?: number;
  downloadDelayMs?: number;
  clips?: MockClip[];
  searchDelayMs?: number;
  dropFirstDownloads?: number;
  settingsFailures?: string[];
  ignoreWrites?: string[];
  rebootMs?: number;
  rebootDropsConnection?: boolean;
}

export const DEFAULT_MOCK_CLIPS: MockClip[] = DEMO_CLIPS;

export interface MockState {
  readonly logins: number;
  readonly loginAttempts: number;
  readonly activeStreams: number;
  readonly streamsOpened: number;
  readonly devInfoCalls: number;
  offline: boolean;
  rejectAllStreams: boolean;
  readonly downloads: number;
  readonly activeDownloads: number;
  readonly droppedDownloads: number;
  readonly downloadOrder: string[];
  readonly settings: CamSim['engine']['settings']['running'];
  readonly setCalls: string[];
  readonly reboots: number;
  // What GetHddInfo reports: capacity and FREE space (size), in MB.
  readonly hddInfo: { capacity: number; size: number };
  revokeTokens(): void;
  dropStreams(): void;
  dropDownloads(): void;
}

export async function createMockCamera(opts: MockCameraOptions): Promise<{ app: CamSim['cameraApp']; state: MockState; sim: CamSim }> {
  const faults: FaultSpec[] = [
    // The old mock showed a partial write's resets at once; the firmware
    // (and cam-sim by default) only after a reboot.
    { name: 'settings.strictPartial' },
  ];
  if (opts.flvDelayMs) faults.push({ name: 'flv.delayMs', ms: opts.flvDelayMs });
  if (opts.downloadDelayMs) faults.push({ name: 'downloads.delayMs', ms: opts.downloadDelayMs });
  if (opts.searchDelayMs) faults.push({ name: 'search.delayMs', ms: opts.searchDelayMs });
  if (opts.dropFirstDownloads) faults.push({ name: 'downloads.dropFirst', count: opts.dropFirstDownloads });
  if (opts.settingsFailures?.length) faults.push({ name: 'settings.fail', cmds: opts.settingsFailures });
  if (opts.ignoreWrites?.length) faults.push({ name: 'settings.ignore', cmds: opts.ignoreWrites });

  const sim = await createCamSim({
    users: [{ name: opts.user, level: 'admin', password: opts.password }],
    name: 'Mock',
    firmVer: opts.firmware ?? 'v3.2.0.6011_mock',
    faults,
    seedClips: (opts.clips ?? DEFAULT_MOCK_CLIPS) as SeedClip[],
    reboot: { ms: opts.rebootMs ?? 50, dropsConnection: opts.rebootDropsConnection ?? false },
    sdMb: 61047, // the real camera's 64 GB card
  });
  // The old mock's device was "Mock" with the on-screen name "Den".
  for (const s of [sim.engine.settings.running, sim.engine.settings.saved]) s.Osd.osdChannel.name = 'Den';
  const e = sim.engine;
  const c = e.counters;
  const toggle = (name: 'offline' | 'flv.reset', on: boolean) => (on ? e.faults.set({ name }) : e.faults.clear(name));
  const state: MockState = {
    get logins() { return c.logins; },
    get loginAttempts() { return c.loginAttempts; },
    get activeStreams() { return c.activeStreams; },
    get streamsOpened() { return c.streamsOpened; },
    get devInfoCalls() { return c.devInfoCalls; },
    get offline() { return e.offline(); },
    set offline(v: boolean) { toggle('offline', v); },
    get rejectAllStreams() { return !!e.faults.active('flv.reset'); },
    set rejectAllStreams(v: boolean) { toggle('flv.reset', v); },
    get downloads() { return c.downloads; },
    get activeDownloads() { return c.activeDownloads; },
    get droppedDownloads() { return c.droppedDownloads; },
    get downloadOrder() { return c.downloadOrder; },
    get settings() { return e.settings.running; },
    get setCalls() { return c.setCalls; },
    get reboots() { return c.reboots; },
    get hddInfo() { return e.sd.hddInfo()[0]; },
    revokeTokens: () => e.sessions.revokeAll(),
    dropStreams: () => e.dropFlv(),
    dropDownloads: () => e.dropDownloads(),
  };
  return { app: sim.cameraApp, state, sim };
}
