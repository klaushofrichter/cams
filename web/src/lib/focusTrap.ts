// A dialog's focus trap (Modal, the Vision and Save dialogs, issues #72 and
// #113): its enabled elements matching `selector`, and Tab / Shift+Tab
// wrapping around them.
export const focusables = (el: HTMLElement | undefined, selector: string): HTMLElement[] =>
  [...(el?.querySelectorAll<HTMLElement>(selector) ?? [])].filter((e) => !e.hasAttribute('disabled'));

// On Tab: focus to the next (Shift: previous) of the dialog's `focusables`,
// wrapping at the ends; anything but Tab, or none to focus, is left alone.
export function trapTab(e: KeyboardEvent, focusables: () => HTMLElement[]): void {
  if (e.key !== 'Tab') return;
  const list = focusables();
  if (!list.length) return;
  const i = list.indexOf(document.activeElement as HTMLElement);
  e.preventDefault();
  list[e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : i === list.length - 1 ? 0 : i + 1].focus();
}
