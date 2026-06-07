import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireRunLock, AlreadyRunningError, isProcessAlive } from '../../src/harness/lock.js';

describe('Run lock (O11 / appendix #3: concurrent runs cannot clobber)', () => {
  let phoenixDir: string;

  beforeEach(() => {
    phoenixDir = mkdtempSync(join(tmpdir(), 'phoenix-lock-'));
  });

  it('acquires the lock and writes the owning pid', () => {
    const lock = acquireRunLock(phoenixDir);
    expect(existsSync(lock.path)).toBe(true);
    expect(Number(readFileSync(lock.path, 'utf8').trim())).toBe(process.pid);
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });

  it('a second acquire while one is held throws AlreadyRunning with the pid', () => {
    const first = acquireRunLock(phoenixDir);
    // Simulate a different live owner by rewriting the pid to a known-live one
    // that is not us (use the parent's pid — guaranteed alive, != our pid only
    // if ppid differs; fall back to writing our own pid + a sentinel check).
    writeFileSync(first.path, String(process.ppid || process.pid));
    expect(() => acquireRunLock(phoenixDir)).toThrow(AlreadyRunningError);
    first.release();
  });

  it('reclaims a stale lock left by a dead process', () => {
    // A pid that is almost certainly not alive.
    const deadPid = 2_147_483_000;
    expect(isProcessAlive(deadPid)).toBe(false);
    writeFileSync(join(phoenixDir, 'run.lock'), String(deadPid));

    // Should reclaim rather than throw.
    const lock = acquireRunLock(phoenixDir);
    expect(Number(readFileSync(lock.path, 'utf8').trim())).toBe(process.pid);
    lock.release();
  });
});
