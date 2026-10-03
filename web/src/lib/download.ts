// Starts the browser's download of `href` (a URL or an object URL), as a
// click on an <a download> would.
export function triggerDownload(href: string, name = ''): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
