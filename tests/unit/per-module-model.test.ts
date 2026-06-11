/**
 * G2 — per-module model selection (role-based) + G3 default resolution.
 * See https://github.com/collectiveleap/phoenix/issues/15.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateIU } from '../../src/regen.js';
import { planIUs } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { deriveInterfaces } from '../../src/scaffold.js';
import { RunJournal } from '../../src/observe/journal.js';
import { resolveModelsByRole } from '../../src/llm/resolve.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

/** Captures the model passed in GenerateOptions for each call. */
class ModelRecordingProvider implements LLMProvider {
  readonly name = 'rec';
  readonly model = 'default-model';
  seenModels: (string | undefined)[] = [];
  generate(p: string, o?: GenerateOptions): Promise<string> { return this.generateStream(p, o); }
  async generateStream(_p: string, o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    this.seenModels.push(o?.model);
    hooks?.onFirstByte?.();
    hooks?.onChunk?.(20, 'export const x = 1;');
    hooks?.onStopReason?.('end_turn');
    hooks?.onStreamEnd?.();
    return 'export const x = 1;';
  }
}

/** A spec with one web-ui section and one API section → two modules with distinct roles. */
function makeWebAndApiIUs() {
  const spec = [
    '# App',
    '',
    '## Web Experience',
    'The page must render the list in the browser with CSS styling.',
    '',
    '## Tasks',
    'The service must create a task. The service must delete a task.',
  ].join('\n');
  const clauses = parseSpec(spec, 'app.md');
  const canon = extractCanonicalNodes(clauses);
  const ius = planIUs(canon, clauses);
  const interfaces = deriveInterfaces(ius, canon);
  return { ius, canon, interfaces };
}

describe('G2: the generation model is selected per module by role', () => {
  let phoenixRoot: string;
  beforeEach(() => { phoenixRoot = mkdtempSync(join(tmpdir(), 'phoenix-g2-')); });

  it('passes the web-ui model to the web-ui module and the api model to the api module', async () => {
    const { ius, canon, interfaces } = makeWebAndApiIUs();
    const webIU = ius.find(iu => interfaces.find(e => e.iu_id === iu.iu_id)?.role === 'web-ui')!;
    const apiIU = ius.find(iu => interfaces.find(e => e.iu_id === iu.iu_id)?.role === 'api')!;
    expect(webIU).toBeDefined();
    expect(apiIU).toBeDefined();

    const modelsByRole = { 'web-ui': 'opus', 'api': 'sonnet' };

    const webProvider = new ModelRecordingProvider();
    const journal = new RunJournal(phoenixRoot);
    journal.startRun();
    const webResult = await generateIU(webIU, { llm: webProvider, canonNodes: canon, interfaces, allIUs: ius, modelsByRole, journal });
    expect(webProvider.seenModels[0]).toBe('opus');
    // The manifest records the effective per-module model.
    expect(webResult.manifest.regen_metadata.model_id).toBe('rec/opus');

    const apiProvider = new ModelRecordingProvider();
    const apiResult = await generateIU(apiIU, { llm: apiProvider, canonNodes: canon, interfaces, allIUs: ius, modelsByRole, journal });
    expect(apiProvider.seenModels[0]).toBe('sonnet');
    expect(apiResult.manifest.regen_metadata.model_id).toBe('rec/sonnet');
  });

  it('falls back to the provider default model when no role override is set', async () => {
    const { ius, canon, interfaces } = makeWebAndApiIUs();
    const provider = new ModelRecordingProvider();
    const result = await generateIU(ius[0], { llm: provider, canonNodes: canon, interfaces, allIUs: ius });
    expect(provider.seenModels[0]).toBeUndefined(); // no override → provider uses its own default
    expect(result.manifest.regen_metadata.model_id).toBe('rec/default-model');
  });
});

describe('G2/G3: resolveModelsByRole precedence (default → config → env)', () => {
  const saved = { ...process.env };
  let phoenixDir: string;
  beforeEach(() => {
    phoenixDir = mkdtempSync(join(tmpdir(), 'phoenix-g2cfg-'));
    delete process.env.PHOENIX_LLM_MODEL_WEBUI;
    delete process.env.PHOENIX_LLM_MODEL_API;
  });
  afterEach(() => { process.env = { ...saved }; });

  it('defaults web-ui→opus / api→sonnet for claude-cli only', () => {
    expect(resolveModelsByRole(phoenixDir, 'claude-cli')).toEqual({ 'web-ui': 'opus', 'api': 'sonnet' });
    // Non-CLI providers get no alias default (aliases would be rejected by the raw API).
    expect(resolveModelsByRole(phoenixDir, 'anthropic')).toEqual({});
  });

  it('config overrides the default and env overrides config', () => {
    writeFileSync(join(phoenixDir, 'config.json'),
      JSON.stringify({ llm: { provider: 'claude-cli', model: 'sonnet', modelsByRole: { 'web-ui': 'opus-4-5' } } }));
    expect(resolveModelsByRole(phoenixDir, 'claude-cli')['web-ui']).toBe('opus-4-5');
    process.env.PHOENIX_LLM_MODEL_WEBUI = 'opus-4-8';
    expect(resolveModelsByRole(phoenixDir, 'claude-cli')['web-ui']).toBe('opus-4-8');
  });
});
