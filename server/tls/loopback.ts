// Where a pinned site CA may be used over plain http (cam-proxy spec
// 2026-10-05 §12.1): only on the proxy's own host (127.0.0.0/8, [::1],
// localhost). Anywhere else a pin needs https, or the token travels in clear.
export function isLoopbackUrl(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  return h === 'localhost' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export const pinTransportOk = (url: URL): boolean => url.protocol === 'https:' || isLoopbackUrl(url);
