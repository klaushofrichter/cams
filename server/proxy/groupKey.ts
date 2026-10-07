// One cam-proxy, as cams knows it in one account: the account, its URL
// (trailing slashes dropped) and the client token cams uses there (cam-proxy
// spec 2026-10-05 §12.1; migration P4: the same proxy in two accounts is two
// groups, nothing is shared across accounts). The key holds the token: never
// log it.
export const proxyGroupKey = (accountId: string, p: { url: string; token: string }): string => `${accountId}\u0000${p.url.replace(/\/+$/, '')}\u0000${p.token}`;
