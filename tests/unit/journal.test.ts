import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunJournal, DEFAULT_BUDGETS } from '../../src/observe/journal.js';
import type { CallRecord } from '../../src/observe/journal.js';

describe('RunJournal (O1: per-call lifecycle is reconstructable)', () => {
  let phoenixRoot: string;

  beforeEach(() => {
    phoenixRoot = mkdtempSync(join(tmpdir(), 'phoenix-journal-'));
  });

  it('records a full call lifecycle and persists it queryably after the run', () => {
    const j = new RunJournal(phoenixRoot);
    j.startRun();
    j.startStage('generate');
    const callId = j.startCall({
      stage: 'generate',
      target: 'AuthIU',
      attempt: 0,
      provider: 'claude-cli',
      model: 'sonnet',
      promptBytes: 1234,
    });
    j.firstByte(callId);
    j.progress(callId, 2048);
    j.streamEnd(callId);
    j.endCall(callId, { outcome: 'ok', bytesStreamed: 2048, tokens: 512 });
    j.endStage('generate');
    j.endRun('ok');

    // Queryable after the fact from disk alone — no in-memory handle.
    const state = RunJournal.readState(phoenixRoot, j.runId);
    expect(state).not.toBeNull();
    const rec = state!.calls.find(c => c.callId === callId)!;
    expect(rec.stage).toBe('generate');
    expect(rec.target).toBe('AuthIU');
    expect(rec.provider).toBe('claude-cli');
    expect(rec.model).toBe('sonnet');
    expect(rec.promptBytes).toBe(1234);
    expect(rec.ttfbAt).toBeDefined();
    expect(rec.bytesStreamed).toBe(2048);
    expect(rec.tokens).toBe(512);
    expect(rec.outcome).toBe('ok');

    // Raw event stream is also persisted.
    const events = RunJournal.readEvents(phoenixRoot, j.runId);
    expect(events.map(e => e.type)).toEqual(
      expect.arrayContaining([
        'run_start', 'stage_start', 'call_start', 'call_first_byte',
        'call_progress', 'call_stream_end', 'call_end', 'stage_end', 'run_end',
      ]),
    );
  });

  it('classifies every call state from records alone (no OS inspection)', () => {
    const base: CallRecord = {
      callId: 'c1', stage: 's', attempt: 0, provider: 'p', model: 'm',
      promptBytes: 10, startedAt: 1_000, bytesStreamed: 0,
    };

    // completed
    expect(RunJournal.classify({ ...base, endedAt: 2_000, outcome: 'ok' }, DEFAULT_BUDGETS, 3_000))
      .toBe('completed');
    // failed
    expect(RunJournal.classify({ ...base, endedAt: 2_000, outcome: 'error' }, DEFAULT_BUDGETS, 3_000))
      .toBe('failed');
    // healthy: just started, within startup budget
    expect(RunJournal.classify(base, DEFAULT_BUDGETS, 1_000 + 5_000))
      .toBe('healthy');
    // startup-stalled: no first byte past budget
    expect(RunJournal.classify(base, DEFAULT_BUDGETS, 1_000 + DEFAULT_BUDGETS.startupMs + 1))
      .toBe('startup-stalled');
    // stream-stalled: first byte then silence past budget
    const streaming: CallRecord = { ...base, ttfbAt: 1_500, lastByteAt: 1_500 };
    expect(RunJournal.classify(streaming, DEFAULT_BUDGETS, 1_500 + DEFAULT_BUDGETS.streamStallMs + 1))
      .toBe('stream-stalled');
    // returned-then-wedged: stream ended but never finalized
    const wedged: CallRecord = { ...base, ttfbAt: 1_500, lastByteAt: 1_800, streamEndedAt: 2_000 };
    expect(RunJournal.classify(wedged, DEFAULT_BUDGETS, 2_000 + DEFAULT_BUDGETS.wedgeMs + 1))
      .toBe('returned-then-wedged');
  });

  it('lists runs newest-first and tracks active calls', () => {
    const j = new RunJournal(phoenixRoot);
    j.startRun();
    const callId = j.startCall({
      stage: 'generate', attempt: 0, provider: 'p', model: 'm', promptBytes: 1,
    });
    expect(j.activeCalls().map(c => c.callId)).toContain(callId);
    j.endCall(callId, { outcome: 'ok' });
    expect(j.activeCalls()).toHaveLength(0);

    expect(RunJournal.listRuns(phoenixRoot)).toContain(j.runId);
  });
});
