/**
 * #30 — plan-split regen was non-deterministic: a transient slice stall shortened/omitted the
 * module (no local recovery → whole-strategy re-roll), and slices invented a cross-module op
 * (`update`) the append-only store doesn't implement (slices weren't grounded in the backend
 * op-vocab). Fixes: per-slice local retry, and backend-op grounding in the slice prompts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { generateIU, backendOpsForPrompt } from '../../src/regen.js';
import { planIUs } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { deriveInterfaces } from '../../src/scaffold.js';
import { resolveTarget } from '../../src/architectures/index.js';
import { restDialect } from '../../src/architectures/dialects/rest.js';
import { makeContract } from '../../src/models/interface-contract.js';
import type { InterfaceEntry } from '../../src/scaffold.js';
import type { ImplementationUnit } from '../../src/models/iu.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

afterEach(() => { delete process.env.PHOENIX_WEBUI_SLICE_BYTES; });

describe('#30: slice prompts are grounded in the backend op-vocab (no invented ops)', () => {
  it('lists the provider operations with a "call ONLY these / never invent" guard', () => {
    const target = resolveTarget('web-api/node-typescript')!;
    const ops = restDialect.deriveOperations({ name: 'Op Store' } as unknown as ImplementationUnit, []);
    const contract = makeContract('store-iu', 'Op Store', ops, 'an op has a seq and a payload');
    const entry: InterfaceEntry = {
      iu_id: 'store-iu', name: 'Op Store', mount_path: '/op-store', role: 'api', resource_fields: '', contract,
    };
    const out = backendOpsForPrompt([entry], target);
    expect(out).toMatch(/call ONLY these/);
    expect(out).toMatch(/never invent/i);
    expect(out).toContain('/op-store');           // the real store address the slice must use
    expect(backendOpsForPrompt([], target)).toBe('');  // no providers → nothing
  });
});

const SHELL = "router.get('/', (c) => c.html(`<!DOCTYPE html><body><div id=app></div>"
  + "<script>let state=[];function render(){}/* __HANDLERS__ */</script></body></html>`));";

/** First slice call stalls once (transient), then succeeds — exercises the per-slice local retry. */
class FlakySliceProvider implements LLMProvider {
  readonly name = 'fake'; readonly model = 'test';
  sliceCalls = 0;
  generate(p: string, o?: GenerateOptions) { return this.generateStream(p, o); }
  async generateStream(prompt: string, _o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    if (/implementing slice \d/.test(prompt)) {
      this.sliceCalls++;
      if (this.sliceCalls === 1) throw new Error('Watchdog killed stalled call (transient stall)'); // first attempt stalls
      const text = "document.addEventListener('keydown', SLICE_RECOVERED);";
      hooks?.onFirstByte?.(); hooks?.onChunk?.(text.length, text); hooks?.onStopReason?.('end_turn'); hooks?.onStreamEnd?.();
      return text;
    }
    hooks?.onFirstByte?.(); hooks?.onChunk?.(SHELL.length, SHELL); hooks?.onStopReason?.('end_turn'); hooks?.onStreamEnd?.();
    return SHELL;
  }
}

describe('#30: a transient slice stall is recovered locally, not dropped', () => {
  it('retries the stalled slice and assembles a complete module', async () => {
    process.env.PHOENIX_WEBUI_SLICE_BYTES = '0'; // force the strategy/slice path
    const target = resolveTarget('web-api/node-typescript')!;
    const clauses = parseSpec('# Web Experience\n\nThe page must render the list. Typing @ opens a picker.', 'web.md');
    const canon = extractCanonicalNodes(clauses);
    const ius = planIUs(canon, clauses, { roleSurfaces: target.architecture.roleSurfaces });
    const interfaces = deriveInterfaces(ius, canon, target);
    const provider = new FlakySliceProvider();

    const result = await generateIU(ius[0], {
      llm: provider, canonNodes: canon, allIUs: ius, interfaces, target, skipAuxGeneration: true,
    });
    const code = result.files.get(ius[0].output_files[0])!;

    expect(result.failed).toBeUndefined();
    expect(provider.sliceCalls).toBeGreaterThanOrEqual(2);  // first stalled, retried
    expect(code).toContain('SLICE_RECOVERED');              // the slice's content is present, not dropped
    expect(code).not.toContain('/* __HANDLERS__ */');       // composed at the marker
  });
});
