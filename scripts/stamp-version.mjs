#!/usr/bin/env node
/**
 * Stamp the Phoenix build with its git provenance so the running CLI can report which Phoenix version
 * produced a regeneration — the join key between loop-bramble-regen and loop-improve-phoenix.
 *
 * Runs at BUILD time, in the Phoenix source tree. It must NOT be a runtime `git rev-parse`: the CLI's
 * cwd is the *target* project being regenerated (e.g. the Bramble workspace), not Phoenix's source, so
 * a runtime git call would report the wrong repo's SHA. The stamped `dist/version.json` is then read at
 * runtime relative to the CLI's own location.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (cmd) => {
  try { return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
};

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const commit = git('git rev-parse HEAD') || 'unknown';
const dirty = git('git status --porcelain') !== '';
const version = { npm_version: pkg.version, commit, dirty, built_at: new Date().toISOString() };

const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, 'version.json'), JSON.stringify(version, null, 2) + '\n', 'utf8');
console.log(`stamped dist/version.json — ${commit.slice(0, 12)}${dirty ? '-dirty' : ''}`);
