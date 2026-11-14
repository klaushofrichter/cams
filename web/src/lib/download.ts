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

// Saves a blob as a download named `name`; its object URL is let go after 10 s.
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  triggerDownload(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// What a snapshot is of (spec 2026-10-04): the camera's live picture, a
// recording's frame, or a still.
export type SnapshotKind = 'live' | 'rec' | 'still';

// "cam1-rec-2026-10-04-14-03-22.jpg": the moment saved, UTC, as before.
export function snapshotName(cam: string, kind: SnapshotKind, t: number): string {
  return `${cam}-${kind}-${new Date(t).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`;
}
