/**
 * Instrumented LLM generation — wires a provider's streaming hooks to the
 * RunJournal so every call self-records its full lifecycle (PRD O1).
 *
 * This is the single chokepoint every supervised LLM call should pass through.
 * The watchdog (Step 3) layers timeout/kill on top by supplying an AbortSignal.
 */

import { RunJournal } from './journal.js';
import type { CallOutcome } from './journal.js';
import type { LLMProvider, GenerateOptions } from '../llm/provider.js';
import { isTruncationStopReason } from '../llm/provider.js';

/** Identifies a call within the run, minus the provider-derived fields. */
export interface CallContext {
  stage: string;
  target?: string;
  attempt: number;
}

/**
 * A generation that completed-but-truncated: the model hit the output-token
 * budget (`stop_reason: max_tokens` / `length`). Thrown by `recordedGenerate`
 * after the call is recorded as `truncated`, so callers can distinguish a
 * deterministic over-budget result from a transient failure and skip retries
 * (T2/T3). Carries the partial text and how far it got.
 */
export class TruncationError extends Error {
  readonly stopReason: string;
  readonly bytesStreamed: number;
  readonly partialText: string;
  constructor(stopReason: string, bytesStreamed: number, partialText: string) {
    super(`Generation truncated at the output-token budget (stop_reason: ${stopReason})`);
    this.name = 'TruncationError';
    this.stopReason = stopReason;
    this.bytesStreamed = bytesStreamed;
    this.partialText = partialText;
  }
}

/** Optional observers around a recorded generation. */
export interface RecordHooks {
  /** Called with the journal callId once the call is opened (for the watchdog). */
  onCallStart?: (callId: string) => void;
}

/** Classify an error message into a terminal outcome. */
function outcomeForError(message: string): CallOutcome {
  return /timed out|timeout|killed by SIG|abort/i.test(message) ? 'timeout' : 'error';
}

/**
 * Run a generation through the journal. Records start, first-byte, progress,
 * stream-end, and a terminal outcome (ok | empty | error | timeout).
 * Re-throws on failure after recording.
 */
export async function recordedGenerate(
  journal: RunJournal,
  provider: LLMProvider,
  prompt: string,
  options: GenerateOptions | undefined,
  ctx: CallContext,
  hooks?: RecordHooks,
): Promise<string> {
  const callId = journal.startCall({
    stage: ctx.stage,
    target: ctx.target,
    attempt: ctx.attempt,
    provider: provider.name,
    model: provider.model,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
  });
  hooks?.onCallStart?.(callId);

  let lastBytes = 0;
  let stopReason: string | undefined;

  try {
    const text = await provider.generateStream(prompt, options, {
      onFirstByte: () => journal.firstByte(callId),
      onChunk: (total) => {
        lastBytes = total;
        journal.progress(callId, total);
      },
      onStreamEnd: () => journal.streamEnd(callId),
      onStopReason: (reason) => { stopReason = reason; },
    });

    // A `max_tokens`/`length` stop reason is completed-but-truncated (over budget),
    // distinct from a normal completion — recorded as `truncated`, then surfaced
    // as a TruncationError so the caller does not retry it (T2/T3).
    if (isTruncationStopReason(stopReason)) {
      journal.endCall(callId, { outcome: 'truncated', bytesStreamed: lastBytes, stopReason });
      throw new TruncationError(stopReason!, lastBytes, text);
    }
    const outcome: CallOutcome = !text || text.trim().length === 0 ? 'empty' : 'ok';
    journal.endCall(callId, { outcome, bytesStreamed: lastBytes, stopReason });
    return text;
  } catch (err) {
    if (err instanceof TruncationError) throw err; // already recorded above
    const message = err instanceof Error ? err.message : String(err);
    journal.endCall(callId, {
      outcome: outcomeForError(message),
      bytesStreamed: lastBytes,
      errorText: message,
    });
    throw err;
  }
}

/**
 * Record a non-streaming generation (uses `generate`, not `generateStream`).
 * For high-volume small calls (e.g. canonicalization normalization) where the
 * stream lifecycle isn't needed but the call must still appear in O1 records.
 */
export async function recordPlainGenerate(
  journal: RunJournal,
  provider: LLMProvider,
  prompt: string,
  options: GenerateOptions | undefined,
  ctx: CallContext,
): Promise<string> {
  const callId = journal.startCall({
    stage: ctx.stage,
    target: ctx.target,
    attempt: ctx.attempt,
    provider: provider.name,
    model: provider.model,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
  });
  try {
    const text = await provider.generate(prompt, options);
    journal.firstByte(callId);
    const bytes = Buffer.byteLength(text ?? '', 'utf8');
    journal.endCall(callId, {
      outcome: !text || text.trim().length === 0 ? 'empty' : 'ok',
      bytesStreamed: bytes,
    });
    return text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    journal.endCall(callId, { outcome: outcomeForError(message), errorText: message });
    throw err;
  }
}
