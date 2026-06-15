/**
 * #27 — web-ui generation experiment harness. The pipeline is constant; only the selected
 * WebUIStrategy varies. Verifies selection, that each strategy composes a body behind the seam,
 * the plan-split durability guarantee (its shell prompt is invariant to behaviour count), and
 * that #9 fail-fast holds for every strategy.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { generateIU, selectWebUIStrategy, WEBUI_STRATEGIES } from '../../src/regen.js';
import { buildShellPrompt, buildBoundedShellPrompt } from '../../src/llm/prompt.js';
import { planIUs } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { deriveInterfaces } from '../../src/scaffold.js';
import { resolveTarget } from '../../src/architectures/index.js';
import { CanonicalType } from '../../src/models/canonical.js';
import type { CanonicalNode } from '../../src/models/canonical.js';
import type { ImplementationUnit } from '../../src/models/iu.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

const SHELL =
  "router.get('/', (c) => c.html(`<!DOCTYPE html><body><div id=app></div><script>let state=[];"
  + "function render(){} /* __CONTRACT__ state: {nodes} render(): redraws elements: #app __ENDCONTRACT__ */ "
  + "/* __HANDLERS__ */</script></body></html>`));";

/** Shell for shell prompts, a tagged handler block for slice prompts, a whole module otherwise. */
class StrategyProvider implements LLMProvider {
  readonly name = 'fake'; readonly model = 'test';
  shell = 0; slice = 0; single = 0; ui = 0;
  constructor(private failAll = false) {}
  generate(p: string, o?: GenerateOptions) { return this.generateStream(p, o); }
  async generateStream(prompt: string, _o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    if (this.failAll) throw new Error('stalled (test)');
    let text: string;
    if (/Output the shell module now/.test(prompt)) { this.shell++; text = SHELL; }
    else if (/implementing slice \d/.test(prompt)) { this.slice++; text = `document.addEventListener('keydown', SLICE_${this.slice});`; }
    else if (/Playwright|getByRole|@playwright/i.test(prompt)) { this.ui++; text = "import { test } from '@playwright/test';\ntest('x', async () => {});"; }
    else { this.single++; text = "router.get('/', (c) => c.html(`<html>whole</html>`));"; }
    hooks?.onFirstByte?.(); hooks?.onChunk?.(text.length, text); hooks?.onStopReason?.('end_turn'); hooks?.onStreamEnd?.();
    return text;
  }
}

function webIU(body = 'The page must render the list. Typing @ opens a picker. Enter splits the line. Tab indents.') {
  const target = resolveTarget('web-api/node-typescript')!;
  const clauses = parseSpec(`# Web Experience\n\n${body}`, 'web.md');
  const canon = extractCanonicalNodes(clauses);
  const ius = planIUs(canon, clauses, { roleSurfaces: target.architecture.roleSurfaces });
  return { target, canon, ius, iu: ius[0], interfaces: deriveInterfaces(ius, canon, target) };
}

function iuWithBehaviours(n: number): { iu: ImplementationUnit; canon: CanonicalNode[] } {
  const canon: CanonicalNode[] = Array.from({ length: n }, (_, i) => ({
    canon_id: `r${i}`, type: CanonicalType.REQUIREMENT,
    statement: `The page must support behaviour ${i} with a distinct key binding and a visible effect.`,
    source_clause_ids: [], linked_canon_ids: [], tags: [],
  } as unknown as CanonicalNode));
  const iu = {
    iu_id: 'iu1', name: 'Web Experience', risk_tier: 'low',
    source_canon_ids: canon.map(c => c.canon_id),
    contract: { description: '', inputs: [], outputs: [], invariants: [] },
  } as unknown as ImplementationUnit;
  return { iu, canon };
}

afterEach(() => {
  delete process.env.PHOENIX_WEBUI_STRATEGY;
  delete process.env.PHOENIX_WEBUI_SLICE_TOKENS;
  delete process.env.PHOENIX_WEBUI_SLICE_BYTES;
});

describe('#27 Finding 1: slicing triggers on prompt bytes, not the canon-id estimate', () => {
  it('slices when the prompt exceeds the byte threshold, single-call when under', async () => {
    const { target, canon, ius, iu, interfaces } = webIU();
    process.env.PHOENIX_WEBUI_SLICE_BYTES = '10';          // any real web-ui prompt exceeds this → slice
    const p1 = new StrategyProvider();
    await generateIU(iu, { llm: p1, canonNodes: canon, allIUs: ius, interfaces, target, skipAuxGeneration: true });
    expect(p1.shell).toBe(1);
    process.env.PHOENIX_WEBUI_SLICE_BYTES = '9999999';     // nothing reaches this → single whole-module call
    const p2 = new StrategyProvider();
    await generateIU(iu, { llm: p2, canonNodes: canon, allIUs: ius, interfaces, target, skipAuxGeneration: true });
    expect(p2.shell).toBe(0);
    expect(p2.single).toBe(1);
  });
});

describe('#27 harness: selection + registry', () => {
  it('defaults to plan-split; selects by name; unknown falls back; tracks general/specific', () => {
    expect(selectWebUIStrategy().name).toBe('plan-split'); // the general strategy that clears the stall (#27)
    expect(selectWebUIStrategy('single').name).toBe('single');
    expect(selectWebUIStrategy('inline-slice').name).toBe('inline-slice');
    expect(selectWebUIStrategy('does-not-exist').name).toBe('plan-split');
    expect(WEBUI_STRATEGIES['plan-split'].general).toBe(true);
    // every registered strategy is general (no spec-coupled strategy in the registry).
    expect(Object.values(WEBUI_STRATEGIES).every(s => s.general)).toBe(true);
  });
});

describe('#27 plan-split durability: bounded shell prompt does not grow with the spec', () => {
  it('plan-split shell is invariant to behaviour count, while inline-slice shell grows', () => {
    const target = resolveTarget('web-api/node-typescript')!;
    const a = iuWithBehaviours(5), b = iuWithBehaviours(25);
    const boundedGrowth = buildBoundedShellPrompt(b.iu, b.canon, [], target).length
      - buildBoundedShellPrompt(a.iu, a.canon, [], target).length;
    const inlineGrowth = buildShellPrompt(b.iu, b.canon, [], target).length
      - buildShellPrompt(a.iu, a.canon, [], target).length;
    expect(boundedGrowth).toBeLessThanOrEqual(2);   // only the behaviour-count digits change
    expect(inlineGrowth).toBeGreaterThan(800);      // the behaviour list scales with the spec
  });
});

describe('#27 harness: each strategy composes a body behind the seam', () => {
  for (const name of ['single', 'inline-slice', 'plan-split']) {
    it(`strategy ${name} produces one served body`, async () => {
      process.env.PHOENIX_WEBUI_SLICE_TOKENS = '0'; // force the strategy path
      process.env.PHOENIX_WEBUI_STRATEGY = name;
      const { target, canon, ius, iu, interfaces } = webIU();
      const provider = new StrategyProvider();
      const result = await generateIU(iu, { llm: provider, canonNodes: canon, allIUs: ius, interfaces, target });
      expect(result.failed).toBeUndefined();
      const code = result.files.get(iu.output_files[0])!;
      if (name === 'single') {
        expect(provider.single).toBe(1);
        expect(provider.shell).toBe(0);
      } else {
        expect(provider.shell).toBe(1);
        expect(provider.slice).toBeGreaterThanOrEqual(1);
        expect(code).not.toContain('/* __HANDLERS__ */'); // composed
      }
    });
  }
});

describe('#27 webui-compare hooks: onWebUIMetrics + skipAuxGeneration', () => {
  it('captures uniform metrics and skips aux test/scenario generation', async () => {
    process.env.PHOENIX_WEBUI_SLICE_TOKENS = '0';
    process.env.PHOENIX_WEBUI_STRATEGY = 'plan-split';
    const { target, canon, ius, iu, interfaces } = webIU();
    const provider = new StrategyProvider();
    let captured: import('../../src/regen.js').WebUIMetrics | undefined;
    const result = await generateIU(iu, {
      llm: provider, canonNodes: canon, allIUs: ius, interfaces, target,
      skipAuxGeneration: true, onWebUIMetrics: (m) => { captured = m; },
    });
    expect(captured?.strategy).toBe('plan-split');
    expect(captured?.success).toBe(true);
    expect(captured?.reachedFirstToken).toBe(true);
    expect(captured?.calls).toBeGreaterThanOrEqual(2);     // shell + ≥1 slice
    expect(provider.ui).toBe(0);                            // aux (ui-scenario) generation skipped
    expect([...result.files.keys()].some(p => /\.(ui\.spec|behavior\.test)\.ts$/.test(p))).toBe(false);
  });
});

describe('#27 harness: #9 fail-fast holds for a strategy that cannot produce', () => {
  it('a stalling strategy → generation_failed, no stub', async () => {
    process.env.PHOENIX_WEBUI_SLICE_TOKENS = '0';
    process.env.PHOENIX_WEBUI_STRATEGY = 'plan-split';
    const { target, canon, ius, iu, interfaces } = webIU();
    const result = await generateIU(iu, {
      llm: new StrategyProvider(true), canonNodes: canon, allIUs: ius, interfaces, target, maxRetries: 0,
    });
    expect(result.failed?.reason).toBe('generation_failed');
    expect(result.files.size).toBe(0);
  });
});
