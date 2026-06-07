/**
 * Run lock + process teardown (PRD O11 / appendix #3).
 *
 * A pid lockfile under `.phoenix/` ensures a second concurrent run exits
 * immediately rather than two runs clobbering each other's output. Stale locks
 * (owning process gone) are reclaimed automatically.
 *
 * `installTeardown` registers signal handlers so that killing a run tears down
 * in-flight work (abort controller) and releases the lock — no orphaned
 * provider/child processes survive.
 */

import { openSync, writeSync, closeSync, existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class AlreadyRunningError extends Error {
  constructor(public readonly pid: number) {
    super(`Phoenix run already in progress (pid ${pid})`);
    this.name = 'AlreadyRunningError';
  }
}

export interface RunLock {
  path: string;
  release(): void;
}

/** Is a process with this pid currently alive? */
export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Acquire the run lock. Throws AlreadyRunningError if a live run holds it.
 * Reclaims a stale lock left by a dead process.
 */
export function acquireRunLock(phoenixDir: string): RunLock {
  mkdirSync(phoenixDir, { recursive: true });
  const lockPath = join(phoenixDir, 'run.lock');

  const tryCreate = (): boolean => {
    try {
      const fd = openSync(lockPath, 'wx'); // atomic create-exclusive
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  };

  if (!tryCreate()) {
    const ownerPid = Number(readFileSync(lockPath, 'utf8').trim());
    if (isProcessAlive(ownerPid) && ownerPid !== process.pid) {
      throw new AlreadyRunningError(ownerPid);
    }
    // Stale lock — reclaim it.
    try { unlinkSync(lockPath); } catch { /* ignore */ }
    if (!tryCreate()) {
      const pid2 = Number(readFileSync(lockPath, 'utf8').trim());
      throw new AlreadyRunningError(pid2);
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (existsSync(lockPath) && Number(readFileSync(lockPath, 'utf8').trim()) === process.pid) {
        unlinkSync(lockPath);
      }
    } catch { /* ignore */ }
  };

  return { path: lockPath, release };
}

/**
 * Register signal/exit handlers that run `teardown` exactly once, then
 * re-raise the signal so the process still exits. Returns an uninstaller.
 */
export function installTeardown(teardown: () => void): () => void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    try { teardown(); } catch { /* ignore */ }
  };

  const onSignal = (sig: NodeJS.Signals) => {
    run();
    // Restore default handling and re-raise so exit code reflects the signal.
    process.removeListener(sig, onSignal);
    process.kill(process.pid, sig);
  };
  const onExit = () => run();

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('exit', onExit);

  return () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('exit', onExit);
  };
}
