/**
 * Eval Parser — reads `evals/*.feature` files and produces durable Evaluation
 * objects.
 *
 * Wraps `@cucumber/gherkin` to handle the standard Gherkin syntax. One Feature
 * heading becomes the spec_section coordinate; one Scenario becomes one
 * Evaluation. Given/When/Then steps map to GivenStep[]/WhenStep[]/ThenStep[].
 *
 * Surface-agnostic by design — the steps are domain-language phrases. Each
 * architecture provides step definitions that translate them into operations
 * on its own surface (HTTP/CLI/etc.). See Architecture.runEvaluation.
 *
 * Resolved fields (iu_id, canon_ids, resolved_at) are populated separately
 * during phoenix bootstrap; the parser only emits the durable layer.
 */

import { Parser, AstBuilder, GherkinClassicTokenMatcher } from '@cucumber/gherkin';
import { IdGenerator } from '@cucumber/messages';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { sha256 } from './semhash.js';
import type {
  Evaluation,
  GivenStep,
  WhenStep,
  ThenStep,
  EvaluationBinding,
} from './models/evaluation.js';

/** Slug-case a Scenario name. "A task can be created" → "a-task-can-be-created" */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parse a single `.feature` file into an array of Evaluations.
 *
 * The feature's heading becomes `subject.spec_section` (single-element).
 * Each scenario becomes one Evaluation. Given/When/Then steps preserve their
 * raw text (no leading keyword) and the parser handles "And"/"But" by
 * inheriting the most recent kind.
 */
export function parseFeatureFile(filePath: string, source?: string): Evaluation[] {
  const text = source ?? readFileSync(filePath, 'utf8');
  const parser = new Parser(
    new AstBuilder(IdGenerator.uuid()),
    new GherkinClassicTokenMatcher(),
  );
  const doc = parser.parse(text);
  const feature = doc.feature;
  if (!feature) return [];

  const specSection = [feature.name];
  const evaluations: Evaluation[] = [];

  for (const child of feature.children ?? []) {
    const scenario = child.scenario;
    if (!scenario) continue;

    const given: GivenStep[] = [];
    const when: WhenStep[] = [];
    const then: ThenStep[] = [];
    type Kind = 'given' | 'when' | 'then';
    let lastKind: Kind | null = null;

    for (const step of scenario.steps ?? []) {
      const kt = step.keywordType;
      let kind: Kind | null = null;
      if (kt === 'Context') kind = 'given';
      else if (kt === 'Action') kind = 'when';
      else if (kt === 'Outcome') kind = 'then';
      else if (kt === 'Conjunction' && lastKind !== null) kind = lastKind;
      if (kind === null) continue;
      const stepText = step.text;
      if (kind === 'given') given.push({ text: stepText });
      else if (kind === 'when') when.push({ text: stepText });
      else then.push({ text: stepText });
      lastKind = kind;
    }

    const name = slugify(scenario.name);
    const describes = scenario.name;
    const binding = inferBinding(scenario.name, given, when, then);

    // Content-address the eval_id from the durable description.
    const durableContent = JSON.stringify({
      name,
      spec_section: specSection,
      given: given.map(s => s.text),
      when: when.map(s => s.text),
      then: then.map(s => s.text),
    });
    const eval_id = `eval:${sha256(durableContent)}`;

    evaluations.push({
      eval_id,
      name,
      subject: { spec_section: specSection, describes, binding },
      given,
      when,
      then,
      origin: 'specified',
      conservation: false,
      created_at: new Date().toISOString(),
    });
  }

  return evaluations;
}

/**
 * Heuristic: decide which EvaluationBinding category fits this scenario based
 * on its language. Conservative defaults; specific overrides recognized:
 *   - mentions "rejected"/"validation"/"fails" → failure_mode
 *   - mentions "always"/"every"/"never" → invariant
 *   - mentions "within Nms"/"latency"/"throughput" → constraint
 *   - default → boundary_contract
 */
function inferBinding(
  name: string,
  _given: GivenStep[],
  when: WhenStep[],
  then: ThenStep[],
): EvaluationBinding {
  const text = (name + ' ' + when.map(s => s.text).join(' ') + ' ' + then.map(s => s.text).join(' ')).toLowerCase();
  if (/\b(rejected|fails|invalid|constraint violation)\b/.test(text)) return 'failure_mode';
  if (/\b(always|every|never)\b/.test(text)) return 'invariant';
  if (/\b(within|latency|throughput|p\d+)\b/.test(text)) return 'constraint';
  return 'boundary_contract';
}

/**
 * Read all `*.feature` files under an `evals/` directory and return the
 * concatenated list of parsed Evaluations.
 *
 * If the directory doesn't exist, returns []. (Phoenix projects without
 * evaluations are valid; the eval set is intentionally sparse — see
 * docs/SUCCESS-CRITERIA.md, Principle 1.)
 */
export function loadEvaluationsFromDir(evalsDir: string): Evaluation[] {
  if (!existsSync(evalsDir)) return [];
  const entries = readdirSync(evalsDir, { withFileTypes: true });
  const featureFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.feature'))
    .map(e => join(evalsDir, e.name));
  const all: Evaluation[] = [];
  for (const f of featureFiles) {
    try {
      all.push(...parseFeatureFile(f));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse evals file ${basename(f)}: ${msg}`);
    }
  }
  return all;
}
