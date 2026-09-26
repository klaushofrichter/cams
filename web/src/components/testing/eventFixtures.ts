import type { EventClip } from '../../lib/recordings';

// `count` clips inside one clock hour on `date`, one per minute starting at
// :00 (so up to 60 are distinct and land in the same hour bucket). Shared by
// the EventList/DownloadList component tests (fix round 1, items 2-4).
export function makeEvents(date: string, hour: number, count: number): EventClip[] {
  const hh = String(hour).padStart(2, '0');
  const events: EventClip[] = [];
  for (let i = 0; i < count; i++) {
    const mm = String(i).padStart(2, '0');
    const start = `${date}T${hh}:${mm}:00`;
    const id = `${date.replace(/-/g, '')}-${hh}${mm}00-${hh}${mm}05`;
    events.push({ id, start, end: start, durationSec: 5, triggers: ['motion'], sizeSub: 1024, sizeMain: 2048 });
  }
  return events;
}
