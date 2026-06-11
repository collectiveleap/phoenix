/**
 * S1/S5 end-to-end against a REAL `claude` CLI.
 *
 * Gated: runs only when `PHOENIX_E2E=1` and a `claude` binary resolves — it
 * spawns the real CLI and takes seconds/minutes, so it is opt-in and never part
 * of the default unit run. It is the automatable proxy for the diagnosis's
 * decisive evidence (https://github.com/collectiveleap/phoenix/issues/19): a large-output prompt
 * must stream from ~2s with rising bytes, not sit at 0 bytes until completion.
 *
 * Enable:  PHOENIX_E2E=1 node node_modules/vitest/vitest.mjs run tests/e2e/claude-streaming.e2e.test.ts
 *
 * The full S5 acceptance (a `phoenix run` web-UI module booting hands-off) is a
 * manual procedure — see scripts/repro-streaming.sh.
 */
import { describe, it, expect } from 'vitest';
import { resolveClaudePath, ClaudeCliProvider } from '../../src/llm/claude-cli.js';

const ENABLED = process.env.PHOENIX_E2E === '1' && resolveClaudePath() !== null;

describe('Claude CLI streaming — real binary (S1/S5)', () => {
  it.runIf(ENABLED)(
    'streams a large output incrementally (early first byte, rising bytes)',
    async () => {
      const provider = new ClaudeCliProvider('sonnet');
      const prompt =
        'Output ONLY a complete, self-contained inline-HTML single-page app of at ' +
        'least ~200 lines (no markdown fences, no commentary). A todo list is fine.';

      const started = Date.now();
      let firstByteMs = -1;
      const progress: number[] = [];
      const text = await provider.generateStream(prompt, { maxTokens: 8192 }, {
        onFirstByte: () => { firstByteMs = Date.now() - started; },
        onChunk: (total) => { progress.push(total); },
      });

      // Real generation produced substantial output.
      expect(text.length).toBeGreaterThan(1_000);
      expect(text).not.toContain('"type":"assistant"'); // parsed, not raw JSON

      // First byte arrived early — not after the whole response buffered.
      expect(firstByteMs).toBeGreaterThanOrEqual(0);
      expect(firstByteMs).toBeLessThan(30_000);

      // bytesStreamed rose across multiple events — the heart of S1.
      expect(progress.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < progress.length; i++) {
        expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
      }
      expect(progress[progress.length - 1]).toBeGreaterThan(progress[0]);
    },
    180_000,
  );

  it.skipIf(ENABLED)('is skipped unless PHOENIX_E2E=1 and a claude binary resolves', () => {
    expect(true).toBe(true);
  });
});
