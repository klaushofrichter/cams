import { faviconSvg, type IndicatorState } from './liveStatus';

// Swaps the SVG favicon; idle restores the shipped file exactly.
export function setFavicon(state: IndicatorState, doc: Document = document): void {
  const link = doc.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  if (!link) return;
  link.href = state === 'idle' ? '/favicon.svg' : `data:image/svg+xml,${encodeURIComponent(faviconSvg(state))}`;
}
