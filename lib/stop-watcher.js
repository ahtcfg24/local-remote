import fs from 'node:fs/promises';

// Task Scheduler normally terminates the whole process tree. A marker in the
// private runtime directory lets Node release native input and close first.
export function watchStopFile({ file, onStop, onError = () => {}, intervalMs = 250 }) {
  let stopped = false;
  let checking = false;
  const stop = () => { stopped = true; clearInterval(timer); };
  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      await fs.access(file);
      if (stopped) return;
      stop();
      await onStop();
    } catch (error) {
      if (error.code !== 'ENOENT') onError(error);
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(check, intervalMs);
  timer.unref();
  void check();
  return stop;
}
