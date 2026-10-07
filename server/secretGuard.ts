// Secrets go only to confirmed endpoints (migration P4, M6, M §9.7; security
// review C1, I2). In cams-admin mode every proxy token and camera password is
// bound to the endpoint an account admin confirmed — a proxy's URL, CA pins
// and TLS name; a camera's protocol, host, TLS name and its proxy's pins —
// and the clients check the binding where they attach the secret: a secret
// is never sent anywhere else, whatever the configuration says. File mode
// (everything from cameras.json, confirmed by definition) has the guard off.
let on = false;
// secret → endpoints, in memory only (the secrets themselves are in memory
// anyway: the fleet holds them).
const bindings = new Map<string, Set<string>>();
const pinsOf = (pins: readonly string[] | null | undefined) => [...(pins ?? [])].sort().join(',');

export const proxyEndpoint = (e: { url: string; pins: readonly string[] | null; tlsServername: string | null }): string =>
  `proxy|${e.url.replace(/\/+$/, '')}|${pinsOf(e.pins)}|${e.tlsServername ?? ''}`;
export const cameraEndpoint = (e: { protocol: string; host: string; tlsServername?: string | null; pins?: readonly string[] | null }): string =>
  `camera|${e.protocol}|${e.host}|${e.tlsServername ?? ''}|${pinsOf(e.pins)}`;

export function setSecretGuard(enabled: boolean): void {
  on = enabled;
}
export const secretGuardOn = (): boolean => on;
export function clearSecretBindings(): void {
  bindings.clear();
}
export function bindSecret(secret: string, endpoint: string): void {
  if (!secret) return;
  let set = bindings.get(secret);
  if (!set) bindings.set(secret, (set = new Set()));
  set.add(endpoint);
}
// True when the secret may go to this endpoint (always, with the guard off).
export function secretAllowed(secret: string, endpoint: string): boolean {
  return !on || !!bindings.get(secret)?.has(endpoint);
}
