// Every link that leaves this site opens in a new tab (Klaus, 2026-10-27):
// target=_blank, rel=noopener noreferrer, and an accessible hint through
// aria-describedby. Use it on a page's root element, so a new external link
// can't miss it; links rendered later are covered too. Same-site links
// (anchors, /llms.txt, /signin, /auth/…) are left alone.
export function isExternal(href: string, origin = location.origin): boolean {
  try {
    const url = new URL(href, origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin;
  } catch {
    return false;
  }
}

export function externalLinks(node: HTMLElement, hintId: string) {
  const apply = () => {
    for (const a of node.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (!isExternal(a.getAttribute('href')!)) continue;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.setAttribute('aria-describedby', hintId);
    }
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(node, { subtree: true, childList: true });
  return { destroy: () => observer.disconnect() };
}
