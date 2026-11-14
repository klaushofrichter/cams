// The words for a refusal every proxy-relayed camera change shares (the
// camera password, the certificate trust); null for the form's own codes.
export function proxyRelayText(status: number, body: { error?: unknown } | null | undefined): string | null {
  if (status === 503) return "The camera can't be reached.";
  if (status === 403 && body?.error === 'proxy_admin_missing') return "cams has no admin token for this proxy: use the proxy's admin page.";
  return null;
}
