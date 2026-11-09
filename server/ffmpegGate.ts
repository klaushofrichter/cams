import { Semaphore } from './reolink/semaphore';

// Every ffmpeg cams starts (clip thumbnails, the MCP's pictures) runs behind
// this one gate: at most two at a time in all, each pinned to one thread, so
// a burst can't spawn dozens and starve the box (#297).
export const ffmpegGate = new Semaphore(2);
