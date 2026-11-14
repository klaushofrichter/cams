// A plain left click, not handled yet: the in-app links take only these.
// Ctrl, ⌘, Shift (new tab or window), Alt (download), middle clicks and
// clicks something else already handled stay the browser's (code review
// 2026-11-14).
export const isPlainClick = (e: MouseEvent): boolean => !e.defaultPrevented && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
