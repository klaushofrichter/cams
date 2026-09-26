type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => void };

// Desktop browsers put the whole viewer (video + controls) into fullscreen.
// iPhone Safari has no element fullscreen at all; only the <video>'s own
// native player can go fullscreen there, via webkitEnterFullscreen.
export async function enterFullscreen(
  container: HTMLElement | undefined,
  video: HTMLVideoElement | null,
): Promise<'container' | 'video' | 'none'> {
  const el = container as WebkitElement | undefined;
  try {
    if (el?.requestFullscreen) {
      await el.requestFullscreen();
      return 'container';
    }
    if (el?.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
      return 'container';
    }
  } catch {
    // fall through to the video element
  }
  const v = video as WebkitVideo | null;
  if (v?.webkitEnterFullscreen) {
    v.webkitEnterFullscreen();
    return 'video';
  }
  if (v?.requestFullscreen) {
    try {
      await v.requestFullscreen();
      return 'video';
    } catch {
      return 'none';
    }
  }
  return 'none';
}
