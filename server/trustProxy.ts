// Which upstream addresses are proxies rather than clients. A CIDR list, not a
// hop count: Express skips every matching address in X-Forwarded-For and
// returns the first that doesn't, which stays right when the ingress chain
// (Traefik -> Kourier -> queue-proxy today) gains or loses a hop. A hop count
// fails quietly by resolving to a pod address. 10.42/16 = pods, 10.43/16 =
// services (k3s defaults). Also required for req.protocol, which the
// same-origin check builds its expected origin from.
export const TRUST_PROXY = ['loopback', '10.42.0.0/16', '10.43.0.0/16'];
