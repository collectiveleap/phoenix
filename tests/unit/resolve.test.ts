import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProviderInfo, describeResolution } from '../../src/llm/resolve.js';
import { DEFAULT_MODELS } from '../../src/llm/provider.js';

describe('Provider/config resolution (O6: state choice + source, warn on conflict)', () => {
  const saved = { ...process.env };
  let phoenixDir: string;

  beforeEach(() => {
    phoenixDir = mkdtempSync(join(tmpdir(), 'phoenix-resolve-'));
    delete process.env.PHOENIX_LLM_PROVIDER;
    delete process.env.PHOENIX_LLM_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('states provider+model and that it came from env', () => {
    process.env.PHOENIX_LLM_PROVIDER = 'anthropic';
    process.env.PHOENIX_LLM_MODEL = 'claude-x';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const info = resolveProviderInfo(phoenixDir);
    expect(info.name).toBe('anthropic');
    expect(info.model).toBe('claude-x');
    expect(info.providerSource).toBe('env');
    expect(info.modelSource).toBe('env');
    expect(describeResolution(info)[0]).toContain('from env');
  });

  it('reads provider+model from config when no env override', () => {
    writeFileSync(join(phoenixDir, 'config.json'), JSON.stringify({ llm: { provider: 'openai', model: 'gpt-x' } }));
    process.env.OPENAI_API_KEY = 'sk-test';
    const info = resolveProviderInfo(phoenixDir);
    expect(info.name).toBe('openai');
    expect(info.providerSource).toBe('config');
    expect(info.modelSource).toBe('config');
  });

  it('warns when env overrides a conflicting saved config provider', () => {
    writeFileSync(join(phoenixDir, 'config.json'), JSON.stringify({ llm: { provider: 'openai', model: 'gpt-x' } }));
    process.env.PHOENIX_LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const info = resolveProviderInfo(phoenixDir);
    expect(info.conflicts.length).toBeGreaterThan(0);
    expect(info.conflicts.join(' ')).toMatch(/overrides saved config/);
  });

  it('warns when multiple credentials are available with no explicit choice', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-a';
    process.env.OPENAI_API_KEY = 'sk-o';
    const info = resolveProviderInfo(phoenixDir);
    expect(info.available).toEqual(expect.arrayContaining(['anthropic', 'openai']));
    expect(info.conflicts.join(' ')).toMatch(/Multiple providers available/);
  });
});

describe('Default model drift guard (G3: defaults must stay current, not stale)', () => {
  // Update these intentionally when bumping the shipped defaults — a failure here
  // means a default silently drifted out of date (e.g. the old Sonnet 4.0 pin).
  it('ships the intended current provider defaults', () => {
    expect(DEFAULT_MODELS.anthropic).toBe('claude-sonnet-4-6');
    expect(DEFAULT_MODELS['claude-cli']).toBe('sonnet');
  });

  it('does not ship the known-stale Sonnet 4.0 pin', () => {
    expect(DEFAULT_MODELS.anthropic).not.toBe('claude-sonnet-4-20250514');
  });
});
