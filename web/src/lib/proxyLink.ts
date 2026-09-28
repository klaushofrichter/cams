// Opens a camera's cam-proxy UI signed in (Klaus, 2026-09-28): cams mints a
// one-time link server side. The tab opens at once (so no popup blocker),
// then goes to the link; without one, to the plain address and its token
// login. Only a link on the proxy's own address is followed.
export async function openProxyUi(cameraId: string, webUrl: string): Promise<void> {
  const w = window.open('', '_blank');
  let url = webUrl;
  try {
    const r = await fetch(`/api/cameras/${encodeURIComponent(cameraId)}/proxy/login-link`, { method: 'POST', credentials: 'same-origin' });
    const body = r.ok ? ((await r.json()) as { url?: unknown }) : null;
    if (typeof body?.url === 'string' && new URL(body.url).origin === new URL(webUrl).origin) url = body.url;
  } catch {
    // the plain address below
  }
  if (w) {
    w.opener = null;
    w.location.href = url;
  } else {
    window.location.assign(url);
  }
}
