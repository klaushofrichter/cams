// Starts the browser's download of `href` (a URL or an object URL), as a
// click on an <a download> would.
export function triggerDownload(href: string, name = ''): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// What a snapshot is of (spec 2026-10-04): the camera's live picture, a
// recording's frame, or a still.
export type SnapshotKind = 'live' | 'rec' | 'still';

// "cam1-rec-2026-10-04-14-03-22.jpg": the moment saved, UTC, as before.
export function snapshotName(cam: string, kind: SnapshotKind, t: number): string {
  return `${cam}-${kind}-${new Date(t).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`;
}
