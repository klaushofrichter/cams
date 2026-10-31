// The fake cam-proxy's live video: what go2rtc's MSE WebSocket gives cam-proxy
// (cam-proxy plan 2026-10-31-camera-calls-for-cams Task 6), a fragmented MP4
// of a test pattern, made by ffmpeg in real time.
import { spawn } from 'child_process';

export const FAKE_LIVE_MIME = 'video/mp4; codecs="avc1.640029"';

export async function* fmp4Stream(o: { signal: AbortSignal }): AsyncIterable<Buffer> {
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-g', '15', '-an', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const stop = () => ff.kill('SIGKILL');
  o.signal.addEventListener('abort', stop, { once: true });
  try {
    for await (const chunk of ff.stdout) {
      if (o.signal.aborted) break;
      yield chunk as Buffer;
    }
  } finally {
    o.signal.removeEventListener('abort', stop);
    stop();
  }
}
