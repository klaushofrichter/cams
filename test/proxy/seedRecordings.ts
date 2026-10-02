import { getClient } from '../../server/reolink/clients';
import { clipTimes, parseClipName } from '../../server/recordings/clipNames';
import type { FakeProxy, FakeRecording } from './fakeProxy';

// Gives the fake cam-proxy the SD recordings cam-sim holds for `date`, as the
// real proxy lists them (it runs the same Search against the same camera).
// Bodies are made up, so a test can tell where bytes came from; `body`
// replaces them (a real MP4 for thumbnails). This uses the camera's Search:
// read the sim's counters after it.
export async function seedRecordings(fake: FakeProxy, cameraId: string, date: string, body?: (stream: 'sub' | 'main', id: string) => Buffer): Promise<FakeRecording[]> {
  const client = getClient(cameraId);
  if (!client) throw new Error(`no camera ${cameraId}`);
  const time = await client.timeInfo();
  const list: FakeRecording[] = [];
  for (const stream of ['sub', 'main'] as const) {
    for (const f of await client.searchDay(date, stream)) {
      const p = parseClipName(f.name);
      if (!p) continue;
      const t = clipTimes(p, time);
      const id = f.name.slice(f.name.lastIndexOf('/') + 1);
      list.push({ id, start: Date.parse(t.start), end: Date.parse(t.end), stream, body: body?.(stream, id) ?? Buffer.from(`sd ${stream} ${id} `.repeat(stream === 'main' ? 40 : 10)) });
    }
  }
  fake.recordings.set(cameraId, [...(fake.recordings.get(cameraId) ?? []), ...list]);
  return list;
}

// The seeded file of one stream for an event id (YYYYMMDD-HHMMSS-HHMMSS):
// the name holds the date and the start time.
export function recordingOf(list: FakeRecording[], clipId: string, stream: 'sub' | 'main'): FakeRecording {
  const key = `${clipId.slice(0, 8)}_${clipId.slice(9, 15)}_`;
  const r = list.find((x) => x.stream === stream && x.id.includes(key));
  if (!r) throw new Error(`no ${stream} recording for ${clipId}`);
  return r;
}
