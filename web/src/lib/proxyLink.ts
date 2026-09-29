// Opens a camera's cam-proxy UI signed in (Klaus, 2026-09-28): cams mints a
// one-time link server side. The tab opens at once (so no popup blocker),
// then goes to the link; without one, to the plain address and its token
// login. Only a link on the proxy's own address is followed.
export async function openProxyUi(cameraId: string, webUrl: string, w: Window | null = window.open('', '_blank')): Promise<void> {
  if (!w) return; // blocked: never navigate the cams tab away (issue #69)
  let url = webUrl;
  try {
    const r = await fetch(`/api/cameras/${encodeURIComponent(cameraId)}/proxy/login-link`, { method: 'POST', credentials: 'same-origin' });
    const body = r.ok ? ((await r.json()) as { url?: unknown }) : null;
    if (typeof body?.url === 'string' && new URL(body.url).origin === new URL(webUrl).origin) url = body.url;
  } catch {
    // the plain address below
  }
  w.opener = null;
  w.location.href = url;
}

// The proxy links' click handler (issue #69): Ctrl, ⌘, Shift and middle
// clicks stay the browser's (a background tab, the plain address); a blocked
// popup leaves the <a target=_blank> to open the plain address itself.
export function openProxyClick(e: MouseEvent, cameraId: string, webUrl: string): Promise<void> {
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return Promise.resolve();
  const w = window.open('', '_blank');
  if (!w) return Promise.resolve();
  e.preventDefault();
  return openProxyUi(cameraId, webUrl, w);
}
