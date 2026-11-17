import { navigate } from './router';

// A plain left click, not handled yet: the in-app links take only these.
// Ctrl, ⌘, Shift (new tab or window), Alt (download), middle clicks and
// clicks something else already handled stay the browser's (code review
// 2026-11-14).
export const isPlainClick = (e: MouseEvent): boolean => !e.defaultPrevented && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;

// An in-app link's click: a plain one navigates here (true); any other is
// left to the browser (false).
export function spaNavigate(e: MouseEvent, href: string): boolean {
  if (!isPlainClick(e)) return false;
  e.preventDefault();
  navigate(href);
  return true;
}
