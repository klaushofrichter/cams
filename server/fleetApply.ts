// A new fleet in use (fleetEvents 'applied': a pulled snapshot, a confirmed
// held change, a saved password): the clients and the proxies' event streams
// start again with it.
import { resetClients } from './reolink/clients';
import { resetProxyClients } from './proxy/client';
import { startProxyStreams, type StreamOptions } from './proxy/stream';

export function onFleetApplied(o: StreamOptions = {}): void {
  resetClients();
  resetProxyClients(); // no client keeps an endpoint that is no longer the confirmed one
  startProxyStreams(o);
}
