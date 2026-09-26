import { spawn } from 'child_process';

// One frame, one second in, scaled to 320 px wide. ffmpeg's stderr is
// discarded (it can echo file paths); only the exit status matters.
export function makeThumbnail(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      process.env.FFMPEG_PATH || 'ffmpeg',
      ['-v', 'error', '-y', '-ss', '1', '-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', '-f', 'mjpeg', output],
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
