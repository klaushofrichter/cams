import type { CameraConfig } from '../cameraRegistry';
import { groupOf } from '../proxy/groups';
import type { CameraTrust } from '../reolink/http';
import { normalizeFingerprint } from './fingerprint';
import { fallbackPin, setFallbackPin, verifiedCas } from './store';

// How cams checks a camera's certificate (cam-proxy spec 2026-10-05 §12.3).
// A camera of a pinned proxy: its fallback leaf pin when the proxy reported
// one, else the proxy's verified site CA(s) only; any other camera: today's
// rule (tlsServername: public CAs; none: unverified). Config-based: the
// Settings switch for the proxy doesn't change it.
export function cameraTrust(cam: CameraConfig): CameraTrust {
  if (cam.protocol !== 'https') return { kind: 'none' };
  const pins = groupOf(cam.id)?.pins;
  if (pins) {
    const pin = fallbackPin(cam.id);
    if (pin) return { kind: 'pinned', fingerprint: pin };
    const ca = verifiedCas(pins);
    if (!ca.length) return { kind: 'unavailable', reason: 'the proxy’s site CA is not verified yet' };
    return cam.tlsServername ? { kind: 'site-ca', ca, servername: cam.tlsServername } : { kind: 'site-ca', ca };
  }
  return cam.tlsServername ? { kind: 'public', servername: cam.tlsServername } : { kind: 'none' };
}

// The `tls` block of the proxy's camera entry (spec §10.4), read over the
// pinned channel: a camera that refused the import is pinned by the
// fingerprint it serves; back on the site CA, the pin goes. Only for a
// proxy with a pinned site CA: anyone else's word isn't taken.
export async function applyProxyTls(id: string, tls: unknown): Promise<void> {
  if (!groupOf(id)?.pins || typeof tls !== 'object' || tls === null) return;
  const t = tls as { mode?: unknown; fingerprint?: unknown };
  if (t.mode === 'pinned') {
    const fp = normalizeFingerprint(t.fingerprint);
    if (fp) await setFallbackPin(id, fp);
  } else if (t.mode === 'site-ca') await setFallbackPin(id, null);
}
