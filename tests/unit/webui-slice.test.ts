/**
 * #27 B1 — a large web-ui module is generated as a small page SHELL + bounded handler SLICES,
 * each a prompt that reaches first-token fast, composed at the shell's `/* __HANDLERS__ *​/`
 * marker. A small web-ui keeps the single-call path. Plus the composition/grouping/budget units.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { generateIU, composeWebUI, chunkWebUINodes, budgetsForPrompt } from '../../src/regen.js';
import { planIUs } from '../../src/iu-planner.js';
import { parseSpec } from '../../src/spec-parser.js';
import { extractCanonicalNodes } from '../../src/canonicalizer.js';
import { deriveInterfaces } from '../../src/scaffold.js';
import { resolveTarget } from '../../src/architectures/index.js';
import { DEFAULT_BUDGETS } from '../../src/observe/journal.js';
import type { LLMProvider, GenerateOptions, StreamHooks } from '../../src/llm/provider.js';

const SHELL = "router.get('/', (c) => c.html(`<!DOCTYPE html><body><div id=app></div>"
  + "<script>let state=[];function render(){}/* __HANDLERS__ */</script></body></html>`));";

/** Returns a shell for shell prompts, a tagged handler block for slice prompts, a plain module otherwise. */
class SliceProvider implements LLMProvider {
  readonly name = 'fake'; readonly model = 'test';
  shellCalls = 0; sliceCalls = 0; plainCalls = 0;
  generate(p: string, o?: GenerateOptions) { return this.generateStream(p, o); }
  async generateStream(prompt: string, _o?: GenerateOptions, hooks?: StreamHooks): Promise<string> {
    let text: string;
    if (/page SHELL only/.test(prompt)) { this.shellCalls++; text = SHELL; }
    else if (/implementing slice/.test(prompt)) { this.sliceCalls++; text = `document.addEventListener('keydown', SLICE_${this.sliceCalls}_HANDLER);`; }
    else { this.plainCalls++; text = "router.get('/', (c) => c.html(`<html>plain</html>`));"; }
    hooks?.onFirstByte?.(); hooks?.onChunk?.(text.length, text); hooks?.onStopReason?.('end_turn'); hooks?.onStreamEnd?.();
    return text;
  }
}

function webIU(specBody: string) {
  const target = resolveTarget('web-api/node-typescript')!;
  const clauses = parseSpec(`# Web Experience\n\n${specBody}`, 'web.md');
  const canon = extractCanonicalNodes(clauses);
  const ius = planIUs(canon, clauses, { roleSurfaces: target.architecture.roleSurfaces });
  const interfaces = deriveInterfaces(ius, canon, target);
  return { target, canon, ius, iu: ius[0], interfaces };
}

afterEach(() => { delete process.env.PHOENIX_WEBUI_SLICE_TOKENS; });

describe('#27 B1: large web-ui is generated as shell + slices', () => {
  it('generates a shell then handler slices and composes them at the marker', async () => {
    process.env.PHOENIX_WEBUI_SLICE_TOKENS = '0'; // force the slice path regardless of size
    const { target, canon, ius, iu, interfaces } = webIU(
      'The page must render the list. Typing @ opens a picker. Enter splits the line.');
    const provider = new SliceProvider();
    const result = await generateIU(iu, { llm: provider, canonNodes: canon, allIUs: ius, interfaces, target });
    const code = result.files.get(iu.output_files[0])!;

    expect(provider.shellCalls).toBe(1);
    expect(provider.sliceCalls).toBeGreaterThanOrEqual(1);
    expect(code).toContain('SLICE_1_HANDLER');                 // slice spliced in
    expect(code).not.toContain('/* __HANDLERS__ */');          // marker consumed
    expect(code).toContain('function render()');               // shell preserved
  });

  it('leaves a small web-ui on the single-call path (no shell/slice)', async () => {
    const { target, canon, ius, iu, interfaces } = webIU('The page must render the list at GET /.');
    const provider = new SliceProvider();
    await generateIU(iu, { llm: provider, canonNodes: canon, allIUs: ius, interfaces, target });
    expect(provider.shellCalls).toBe(0);
    expect(provider.sliceCalls).toBe(0);
    expect(provider.plainCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('#27 B1: composition and grouping units', () => {
  it('composeWebUI replaces the marker; falls back before </script> when absent', () => {
    expect(composeWebUI('a/* __HANDLERS__ */b', ['X'])).toBe('aXb');
    expect(composeWebUI('a<script>S</script>z', ['X'])).toContain('S\nX\n</script>'); // inserted, not dropped
  });

  it('chunkWebUINodes bounds each slice to the clause cap', () => {
    const { canon, iu } = webIU(
      'The page must render the list. The page must show a header. The page must support search. '
      + 'The page must allow editing. The page must allow deleting. The page must paginate. '
      + 'The page must sort items.'); // 7 behaviour clauses
    const groups = chunkWebUINodes(iu, canon);
    const total = groups.reduce((n, g) => n + g.length, 0);
    expect(groups.length).toBe(Math.ceil(total / 5)); // chunked by the 5-clause cap
    expect(Math.max(...groups.map(g => g.length))).toBeLessThanOrEqual(5);
  });
});

describe('#27 Phase 3: budgetsForPrompt gives a large prompt more first-token room', () => {
  it('raises startupMs for a large prompt, leaves a small one unchanged', () => {
    const small = budgetsForPrompt(DEFAULT_BUDGETS, 1024);
    expect(small.startupMs).toBe(DEFAULT_BUDGETS.startupMs);
    const large = budgetsForPrompt(DEFAULT_BUDGETS, 20 * 1024);
    expect(large.startupMs).toBeGreaterThan(DEFAULT_BUDGETS.startupMs);
  });
});
