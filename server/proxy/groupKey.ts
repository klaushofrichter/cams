// One cam-proxy, as cams knows it: its URL (trailing slashes dropped) and the
// client token cams uses there (cam-proxy spec 2026-10-05 §12.1). The key
// holds the token: never log it.
export const proxyGroupKey = (p: { url: string; token: string }): string => `${p.url.replace(/\/+$/, '')}\u0000${p.token}`;
