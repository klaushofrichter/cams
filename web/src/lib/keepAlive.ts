// Keeps the Live page (and its stream) alive for a while after the user
// leaves it, so coming back shows the picture at once. There is deliberately
// no "forever": an unwatched stream costs bandwidth on the camera's uplink.
export function createKeepAlive(onExpire: () => void): { enter(): void; leave(seconds: number): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    enter: cancel,
    leave(seconds) {
      cancel();
      if (seconds <= 0) onExpire();
      else timer = setTimeout(() => {
        timer = null;
        onExpire();
      }, seconds * 1000);
    },
    dispose: cancel,
  };
}
