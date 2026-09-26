import { spawn } from 'child_process';
import { Semaphore } from '../reolink/semaphore';

// Caps how many ffmpeg processes run at once: each is also pinned to one
// thread (below), but a burst of thumbnail requests could otherwise still
// spawn dozens of them and starve the box.
const gate = new Semaphore(2);

function spawnThumbnail(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      process.env.FFMPEG_PATH || 'ffmpeg',
      ['-v', 'error', '-y', '-threads', '1', '-ss', '1', '-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', '-f', 'mjpeg', output],
      { stdio: 'ignore' },
    );
    const timer = setTimeout(() => ff.kill('SIGKILL'), 15_000);
    ff.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ff.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}`));
    });
  });
}

// One frame, one second in, scaled to 320 px wide. ffmpeg's stderr is
// discarded (it can echo file paths); only the exit status matters.
export function makeThumbnail(input: string, output: string): Promise<void> {
  return gate.run(() => spawnThumbnail(input, output));
}
