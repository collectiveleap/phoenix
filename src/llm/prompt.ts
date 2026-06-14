/**
 * Prompt Builder — constructs LLM prompts from IU contracts.
 *
 * Turns the structured IU (requirements, constraints, invariants,
 * inputs, outputs) into a prompt that produces working TypeScript.
 */

import type { ImplementationUnit } from '../models/iu.js';
import type { CanonicalNode } from '../models/canonical.js';
import type { ResolvedTarget } from '../models/architecture.js';
import type { InterfaceEntry } from '../scaffold.js';
import type { InterfaceContract } from '../models/interface-contract.js';

export const SYSTEM_PROMPT = `You are a senior TypeScript engineer generating production-quality module implementations for Phoenix VCS.

Rules:
- Output ONLY the TypeScript module code. No markdown fences, no explanation.
- The module must be a valid ES module (.ts) that compiles under strict mode.
- Export all public functions and types.
- Use descriptive types (not \`any\` or \`unknown\` where a real type is appropriate).
- Implement the actual logic described in the requirements — not stubs or TODOs.
- Keep the code clean, readable, and minimal. No over-engineering.
- Include the _phoenix metadata constant exactly as specified.
- Do NOT import from external packages. ZERO runtime dependencies.
- Use only Node.js built-in modules (node:crypto, node:events, node:http, etc.) when needed.
- For WebSocket-like features, use raw node:http or define the interface — do NOT import 'ws'.
- For DOM/browser code, do NOT use DOM APIs. Generate string HTML templates instead.
- For EventEmitter, use node:events and cast as needed. Prefer simple callbacks or Maps.
- The code must compile under TypeScript strict mode (strict: true, no implicit any).
- If the requirements describe a data structure, define and export the types.
- If the requirements describe validation rules, implement them with clear error messages.
- If the requirements describe state management, use a class or closure — your choice.`;

/**
 * Build the user prompt for generating an IU implementation.
 */
/**
 * Get the system prompt, optionally extended with architecture-specific rules.
 */
export function getSystemPrompt(target?: ResolvedTarget | null): string {
  if (!target) return SYSTEM_PROMPT;
  const arch = target.architecture;
  const rt = target.runtime;

  const allowedPkgs = Object.keys(rt.packages).map(p => `'${p}'`).join(', ');

  // Build system prompt from architecture + runtime
  return `You are a senior ${rt.language} engineer generating production-quality module implementations.

Rules:
- Implement the actual logic described in the requirements — not stubs or TODOs.
- Keep the code clean, readable, and minimal. No over-engineering.
- You MUST import from these packages: ${allowedPkgs}. Use them as shown in the examples below.
- Do NOT import any other packages. Do NOT re-implement functionality that the allowed packages provide.

${arch.systemPrompt}
${rt.promptExtension}`;
}

/**
 * Build the user prompt for generating an IU implementation.
 */
export function buildPrompt(
  iu: ImplementationUnit,
  canonNodes: CanonicalNode[],
  siblingModules?: InterfaceEntry[],
  target?: ResolvedTarget | null,
): string {
  const lines: string[] = [];

  lines.push(`Generate a TypeScript module implementing "${iu.name}".`);
  lines.push('');

  // For architecture mode, inject the mandatory imports at the top of the prompt
  if (target) {
    lines.push('## MANDATORY: Your module MUST start with these exact imports');
    lines.push('```');
    lines.push(`import { Hono } from 'hono';`);
    lines.push(`import { db, registerMigration } from '../../db.js';`);
    lines.push(`import { z } from 'zod';`);
    lines.push('```');
    lines.push('Do NOT import Database from better-sqlite3. Do NOT create new Database(). Use the db import above.');
    lines.push('');
  }

  // Requirements
  const iuNodes = canonNodes.filter(n => iu.source_canon_ids.includes(n.canon_id));
  const requirements = iuNodes.filter(n => n.type === 'REQUIREMENT');
  const constraints = iuNodes.filter(n => n.type === 'CONSTRAINT');
  const invariants = iuNodes.filter(n => n.type === 'INVARIANT');
  const definitions = iuNodes.filter(n => n.type === 'DEFINITION');

  if (requirements.length > 0) {
    lines.push('## Requirements');
    for (const r of requirements) {
      lines.push(`- ${r.statement}`);
    }
    lines.push('');
  }

  if (constraints.length > 0) {
    lines.push('## Constraints');
    for (const c of constraints) {
      lines.push(`- ${c.statement}`);
    }
    lines.push('');
  }

  if (invariants.length > 0) {
    lines.push('## Invariants');
    for (const inv of invariants) {
      lines.push(`- ${inv.statement}`);
    }
    lines.push('');
  }

  if (definitions.length > 0) {
    lines.push('## Definitions');
    for (const d of definitions) {
      lines.push(`- ${d.statement}`);
    }
    lines.push('');
  }

  // Related context: DEFINITION and CONTEXT nodes from the same spec not in this IU
  if (target) {
    const otherNodes = canonNodes.filter(n =>
      !iu.source_canon_ids.includes(n.canon_id) &&
      (n.type === 'DEFINITION' || n.type === 'CONTEXT')
    );
    if (otherNodes.length > 0) {
      lines.push('## Related Context (from other sections of the same spec)');
      for (const n of otherNodes) {
        lines.push(`- [${n.type}] ${n.statement}`);
      }
      lines.push('');
    }
  }

  // Contract
  if (iu.contract.inputs.length > 0) {
    lines.push(`## Inputs: ${iu.contract.inputs.join(', ')}`);
  }
  if (iu.contract.outputs.length > 0) {
    lines.push(`## Outputs: ${iu.contract.outputs.join(', ')}`);
  }
  lines.push(`## Risk Tier: ${iu.risk_tier}`);
  lines.push('');

  // Context: sibling provider modules and their interface contract (C2). The
  // contract is the authoritative boundary — list each provider's declared
  // operations via the architecture's dialect so the consumer calls exactly those,
  // never an address invented from the spec's domain language.
  if (siblingModules && siblingModules.length > 0) {
    const dialect = target?.runtime.interfaceDialect;
    if (target) {
      lines.push(`## Other modules — call their declared interface ONLY (do NOT import them, do NOT invent paths):`);
      for (const entry of siblingModules) {
        if (entry.role === 'web-ui') continue; // skip other web modules
        if (dialect && entry.contract) {
          lines.push(dialect.describeForPrompt(entry.contract));
          continue;
        }
        // Fallback (no dialect/contract): the legacy mount-path hint.
        let line = `- "${entry.name}" mounted at ${entry.mount_path} — use fetch('${entry.mount_path}') or fetch('${entry.mount_path}/...') to call it`;
        if (entry.resource_fields) line += `. Resource shape: ${entry.resource_fields}`;
        lines.push(line);
      }
    } else {
      lines.push(`## Other modules in this service (for context, do NOT import them):`);
      for (const entry of siblingModules) {
        lines.push(`- ${entry.name}`);
      }
    }
    lines.push('');
  }

  // Phoenix metadata
  lines.push('## Required metadata export');
  lines.push('Include this exact constant at the end of the module:');
  lines.push('```');
  lines.push(`/** @internal Phoenix VCS traceability — do not remove. */`);
  lines.push(`export const _phoenix = {`);
  lines.push(`  iu_id: '${iu.iu_id}',`);
  lines.push(`  name: '${iu.name}',`);
  lines.push(`  risk_tier: '${iu.risk_tier}',`);
  lines.push(`  canon_ids: [${iu.source_canon_ids.length} as const],`);
  lines.push(`} as const;`);
  lines.push('```');
  lines.push('');

  // Architecture patterns (few-shot examples)
  if (target?.runtime.codeExamples) {
    lines.push(target.runtime.codeExamples);
    lines.push('');
  }

  lines.push('Output the complete TypeScript module now.');

  return lines.join('\n');
}

/** System prompt for generating behavioral tests (independent of the implementation). */
/**
 * Build a continuation prompt (#24): the original generation prompt plus everything
 * produced so far, asking the model to continue from exactly where the output was cut
 * off — output only the remaining content, no preamble, no repetition. The response is
 * concatenated directly onto the accumulated output (with seam-overlap stripped by the
 * caller), so a large module is assembled across several bounded calls.
 */
export function buildContinuationPrompt(originalPrompt: string, soFar: string): string {
  return [
    'You are CONTINUING a single file whose output was cut off mid-stream. The following rules OVERRIDE any',
    'formatting or "output the sections in this exact format" instruction in the reference specification below:',
    '- Do NOT restart and do NOT re-emit anything already shown — no imports, no section markers, no',
    '  re-declaration of the router, none of the earlier text.',
    '- Output ONLY the raw characters that come next, continuing from the EXACT end of "OUTPUT SO FAR".',
    '- No preamble, no explanation, no code fences. Your output is appended directly onto the end.',
    '',
    '### Reference specification the file must satisfy (do NOT restart it; for context only)',
    originalPrompt,
    '',
    '--- OUTPUT SO FAR (already emitted; continue from its exact end, do not repeat) ---',
    soFar,
    '--- END OF OUTPUT SO FAR; emit only what comes next ---',
  ].join('\n');
}

/**
 * Build the SHELL prompt for plan-split web-ui generation (#27): the full page skeleton
 * (HTML + inline CSS + shared client state + load()/render() + event-binding scaffold) with
 * a single `/* __HANDLERS__ *​/` marker where the interaction logic is later spliced in. The
 * shell is small enough to reach first-token quickly, unlike the whole SPA in one call.
 */
export function buildShellPrompt(
  iu: ImplementationUnit,
  canonNodes: CanonicalNode[],
  siblingModules: InterfaceEntry[] | undefined,
  target: ResolvedTarget | null | undefined,
): string {
  // The shell prompt must be SMALL so the call reaches first-token (the whole-SPA prompt is
  // what stalls). So it deliberately does NOT inherit buildPrompt's code examples or full
  // formatting — only the data model, a terse capability list (for structure), the backend
  // contract, and skeleton instructions. The detailed behaviour clauses go to the slices.
  const iuNodes = canonNodes.filter(n => iu.source_canon_ids.includes(n.canon_id));
  const model = iuNodes.filter(n => n.type === 'DEFINITION' || n.type === 'CONTEXT');
  const behaviors = iuNodes.filter(n => n.type === 'REQUIREMENT' || n.type === 'CONSTRAINT' || n.type === 'INVARIANT');
  const lines: string[] = [];

  lines.push(`Generate the page SHELL for the web module "${iu.name}". This is a large module built in slices,`);
  lines.push('so produce ONLY the skeleton now — NOT the interaction logic.');
  lines.push('');
  if (target) {
    lines.push('## Start the module with exactly these imports');
    lines.push('```');
    lines.push(`import { Hono } from 'hono';`);
    lines.push(`import { db, registerMigration } from '../../db.js';`);
    lines.push(`import { z } from 'zod';`);
    lines.push('```');
    lines.push('');
  }
  if (model.length > 0) {
    lines.push('## Data model & vocabulary the page works with');
    for (const n of model) lines.push(`- ${n.statement}`);
    lines.push('');
  }
  if (behaviors.length > 0) {
    lines.push('## Capabilities the page supports (implemented SEPARATELY as slices — do NOT implement them here)');
    for (const n of behaviors) lines.push(`- ${n.statement}`);
    lines.push('');
  }
  const providers = (siblingModules ?? []).filter(e => e.role !== 'web-ui');
  const dialect = target?.runtime.interfaceDialect;
  if (providers.length > 0 && dialect) {
    lines.push('## Backend to call (use these exact addresses; do NOT invent paths)');
    for (const entry of providers) if (entry.contract) lines.push(dialect.describeForPrompt(entry.contract));
    lines.push('');
  }
  lines.push('## Your task — the SHELL ONLY');
  lines.push('Return `c.html()` with a complete HTML document, all CSS and JS inline, containing:');
  lines.push('- the full page structure (doctype, <head> with inline <style>, <body> with the structural elements);');
  lines.push('- the shared client-side STATE model, a clear `render()` that draws state into the DOM, and a');
  lines.push('  `load()` that fetches initial data from the backend and calls `render()`;');
  lines.push('- the bare event-binding scaffold.');
  lines.push('Where the interaction handlers (the capabilities above) would be implemented, emit EXACTLY this one');
  lines.push('line and nothing else in their place:');
  lines.push('    /* __HANDLERS__ */');
  lines.push('Do NOT implement the capabilities — they are generated separately and reuse the shared state and');
  lines.push('`render()` you define. Keep the shell small; define state and `render()` clearly so handlers plug in.');
  lines.push('');
  lines.push('## Required metadata export (include verbatim at the end)');
  lines.push('```');
  lines.push(`export const _phoenix = { iu_id: '${iu.iu_id}', name: '${iu.name}', risk_tier: '${iu.risk_tier}', canon_ids: [${iu.source_canon_ids.length} as const] } as const;`);
  lines.push('```');
  lines.push('');
  lines.push('Output the shell module now.');
  return lines.join('\n');
}

/**
 * Build a SLICE prompt for plan-split web-ui generation (#27): implement one bounded group
 * of behaviours as a self-contained JS block that plugs into the shell's `/* __HANDLERS__ *​/`
 * marker, using the shell's shared state/render() as the contract. Bounded → fast first-token.
 */
export function buildSlicePrompt(
  iu: ImplementationUnit,
  sliceNodes: CanonicalNode[],
  shellBody: string,
  _target: ResolvedTarget | null | undefined,
  index: number,
): string {
  return [
    `You are implementing slice ${index + 1} of the interaction logic for the web page "${iu.name}".`,
    "The page SHELL below is already generated — it defines the shared client-side state, `render()`, and `load()`.",
    'Implement ONLY the behaviours listed below, as a self-contained block of client-side JavaScript (event',
    "listeners + helper functions) that plugs in where the shell has `/* __HANDLERS__ */`, using the shell's",
    'shared state and `render()`.',
    '',
    '### Rules',
    '- Output ONLY the raw JavaScript to insert at the marker — no preamble, no explanation, no code fences, no',
    '  `<script>` tags, no HTML. Do NOT re-emit any part of the shell.',
    '- Reuse the shell\'s shared state and `render()`; do not redeclare them.',
    '- This block sits INSIDE an inline `<script>` within a server-rendered HTML template literal — do not use',
    '  unescaped backticks or `${...}`.',
    '',
    '### Behaviours to implement in this slice',
    ...sliceNodes.map(n => `- [${n.type}] ${n.statement}`),
    '',
    '### Page shell (reference — defines the state/render contract; do NOT re-output it)',
    shellBody,
  ].join('\n');
}

/**
 * Bounded shell prompt for the `plan-split` strategy (#27). Like `buildShellPrompt` but it does
 * NOT enumerate behaviours — only their COUNT — and asks the shell to emit a compact `__CONTRACT__`
 * block (state shape + render() + element ids) that handler slices reference instead of the whole
 * shell. So neither this prompt nor the slice prompts grow with the spec — the durability fix.
 */
export function buildBoundedShellPrompt(
  iu: ImplementationUnit,
  canonNodes: CanonicalNode[],
  siblingModules: InterfaceEntry[] | undefined,
  target: ResolvedTarget | null | undefined,
): string {
  const iuNodes = canonNodes.filter(n => iu.source_canon_ids.includes(n.canon_id));
  const model = iuNodes.filter(n => n.type === 'DEFINITION' || n.type === 'CONTEXT');
  const behaviourCount = iuNodes.filter(n =>
    n.type === 'REQUIREMENT' || n.type === 'CONSTRAINT' || n.type === 'INVARIANT').length;
  const lines: string[] = [];
  lines.push(`Generate the page SHELL for the web module "${iu.name}". This is a large module built in slices;`);
  lines.push('produce ONLY the skeleton now — NOT the interaction logic.');
  lines.push('');
  if (target) {
    lines.push('## Start the module with exactly these imports');
    lines.push('```');
    lines.push(`import { Hono } from 'hono';`);
    lines.push(`import { db, registerMigration } from '../../db.js';`);
    lines.push(`import { z } from 'zod';`);
    lines.push('```');
    lines.push('');
  }
  if (model.length > 0) {
    lines.push('## Data model & vocabulary the page works with');
    for (const n of model) lines.push(`- ${n.statement}`);
    lines.push('');
  }
  lines.push('## Scope');
  lines.push(`The page supports ${behaviourCount} interaction behaviours; each is added SEPARATELY as a slice —`);
  lines.push('do NOT implement them here.');
  lines.push('');
  const providers = (siblingModules ?? []).filter(e => e.role !== 'web-ui');
  const dialect = target?.runtime.interfaceDialect;
  if (providers.length > 0 && dialect) {
    lines.push('## Backend to call (use these exact addresses; do NOT invent paths)');
    for (const entry of providers) if (entry.contract) lines.push(dialect.describeForPrompt(entry.contract));
    lines.push('');
  }
  lines.push('## Your task — the SHELL ONLY');
  lines.push('Return `c.html()` with a complete HTML document, all CSS/JS inline: the full page structure, the');
  lines.push('shared client-side STATE model, a clear `render()` that draws state into the DOM, a `load()` that');
  lines.push('fetches from the backend and renders, and the bare event-binding scaffold.');
  lines.push('`render()` MUST always leave at least one focusable EDITABLE line in the DOM — including when the');
  lines.push('state is EMPTY (render the empty/pending line then), so the page is immediately typable with no');
  lines.push('data. Give editable lines the textbox role (a real input/textarea, or contenteditable +');
  lines.push('`role="textbox"`) so they are locatable by assistive tech and tests even when empty.');
  lines.push('Where the interaction handlers go, emit EXACTLY this line and nothing else for them:');
  lines.push('    /* __HANDLERS__ */');
  lines.push('Immediately inside the opening `<script>`, emit a CONTRACT block the slices rely on — the shared');
  lines.push('state shape, what `render()` does, and the key element ids/selectors handlers target — exactly so:');
  lines.push('    /* __CONTRACT__');
  lines.push('    state: <shape of the shared state object>');
  lines.push('    render(): <one line: what calling render() does>');
  lines.push('    elements: <ids/selectors handlers will target>');
  lines.push('    __ENDCONTRACT__ */');
  lines.push('Keep the shell small; define state and `render()` concretely so slices can plug in.');
  lines.push('');
  lines.push('## Required metadata export (include verbatim at the end)');
  lines.push('```');
  lines.push(`export const _phoenix = { iu_id: '${iu.iu_id}', name: '${iu.name}', risk_tier: '${iu.risk_tier}', canon_ids: [${iu.source_canon_ids.length} as const] } as const;`);
  lines.push('```');
  lines.push('');
  lines.push('Output the shell module now.');
  return lines.join('\n');
}

/**
 * Compact slice prompt for `plan-split` (#27): the slice's own clauses + the shell's CONTRACT block
 * (not the whole shell body), so the prompt size is independent of the shell/spec size.
 */
export function buildCompactSlicePrompt(
  iu: ImplementationUnit,
  sliceNodes: CanonicalNode[],
  contract: string,
  _target: ResolvedTarget | null | undefined,
  index: number,
): string {
  return [
    `You are implementing slice ${index + 1} of the interaction logic for the web page "${iu.name}".`,
    'The page shell already exists. Implement ONLY the behaviours below as a self-contained block of client-side',
    'JavaScript (event listeners + helper functions) that plugs in where the shell has `/* __HANDLERS__ */`,',
    'using the shared state and `render()` described in the CONTRACT.',
    '',
    '### Rules',
    '- Output ONLY the raw JavaScript to insert at the marker — no preamble, no explanation, no code fences, no',
    '  `<script>` tags, no HTML. Do NOT redeclare the shared state or `render()`.',
    '- This block sits INSIDE an inline `<script>` within a server-rendered HTML template literal — no unescaped',
    '  backticks or `${...}`.',
    '- Implement the FULL behaviour, including the GESTURE that CREATES or TRIGGERS it — not only rendering or',
    '  updating data that already exists. If a behaviour says "typing @ creates a reference", wire the @',
    '  keystroke that creates it; do not implement only the rendering of an already-created reference.',
    '',
    '### Shell contract (the shared state / render() / elements you must use)',
    contract,
    '',
    '### Behaviours to implement in this slice',
    ...sliceNodes.map(n => `- [${n.type}] ${n.statement}`),
  ].join('\n');
}

/**
 * Spec-tuned shell prompt for the `bramble` strategy (#27, general:false). Unlike the generic
 * bounded shell, it concretely names the KNOWN outliner regions (outline tree, header/zoom,
 * @-mention picker, backlinks) so the model produces a small, concrete skeleton that reliably
 * reaches first-token. Intentionally Bramble-specific — tracked, not the general solution.
 */
export function buildBrambleShellPrompt(
  iu: ImplementationUnit,
  canonNodes: CanonicalNode[],
  siblingModules: InterfaceEntry[] | undefined,
  target: ResolvedTarget | null | undefined,
): string {
  const lines: string[] = [];
  lines.push(`Generate the page SHELL for a keyboard-driven OUTLINER web app "${iu.name}". Produce ONLY the`);
  lines.push('skeleton now — NOT the interaction handlers.');
  lines.push('');
  if (target) {
    lines.push('## Start the module with exactly these imports');
    lines.push('```');
    lines.push(`import { Hono } from 'hono';`);
    lines.push(`import { db, registerMigration } from '../../db.js';`);
    lines.push(`import { z } from 'zod';`);
    lines.push('```');
    lines.push('');
  }
  lines.push('## The page, concretely');
  lines.push('- a scrollable OUTLINE: a vertical list of nested, indentable lines, each an editable text node');
  lines.push('  (`contenteditable`), with collapse/expand carets;');
  lines.push('- a HEADER bar: the current zoom path (breadcrumb) + the zoomed node title;');
  lines.push('- an inline @-MENTION PICKER: a dropdown shown while typing `@`, listing existing nodes by label;');
  lines.push('- a BACKLINKS panel: nodes that reference the focused node;');
  lines.push('- all CSS inline.');
  lines.push('');
  lines.push('## State & render contract');
  lines.push('- State: the operation log fetched from the backend, folded into a node tree');
  lines.push('  (id → { text, children, collapsed, refs }).');
  lines.push('- `render()`: re-folds the log and redraws the outline, header, and backlinks from state. When the');
  lines.push('  outline is EMPTY it MUST still render a single empty editable line (the pending/trailing line), so');
  lines.push('  the page is immediately typable. Every editable line carries the textbox role (contenteditable +');
  lines.push('  `role="textbox"`) so it is locatable even when empty.');
  lines.push('- `load()`: fetches the operation log from the backend and calls `render()`.');
  lines.push('');
  const providers = (siblingModules ?? []).filter(e => e.role !== 'web-ui');
  const dialect = target?.runtime.interfaceDialect;
  if (providers.length > 0 && dialect) {
    lines.push('## Backend to call (use these exact addresses; do NOT invent paths)');
    for (const entry of providers) if (entry.contract) lines.push(dialect.describeForPrompt(entry.contract));
    lines.push('');
  }
  lines.push('## Your task — the SHELL ONLY');
  lines.push('Return `c.html()` with the complete HTML document (structure + inline CSS), the state model,');
  lines.push('`render()`, `load()`, and the bare event-binding scaffold. Emit EXACTLY `/* __HANDLERS__ */` where');
  lines.push('the handlers go (added separately), and right inside `<script>` a CONTRACT block:');
  lines.push('    /* __CONTRACT__');
  lines.push('    state: <shape of the shared state>');
  lines.push('    render(): <one line>');
  lines.push('    elements: <ids/selectors handlers target: outline, header, picker, backlinks, …>');
  lines.push('    __ENDCONTRACT__ */');
  lines.push('');
  lines.push('## Required metadata export (verbatim at the end)');
  lines.push('```');
  lines.push(`export const _phoenix = { iu_id: '${iu.iu_id}', name: '${iu.name}', risk_tier: '${iu.risk_tier}', canon_ids: [${iu.source_canon_ids.length} as const] } as const;`);
  lines.push('```');
  lines.push('');
  lines.push('Output the shell module now.');
  return lines.join('\n');
}

export function getTestSystemPrompt(target?: ResolvedTarget | null): string {
  const lang = target?.runtime.language ?? 'TypeScript';
  return `You are a senior ${lang} engineer writing behavioral tests with vitest.

Rules:
- Output ONLY the test module code. No markdown fences, no explanation.
- Test the module through its PUBLIC INTERFACE only — do NOT reference or assume its implementation internals.
- Every assertion must come from the stated requirements (the spec), not from how the code happens to work.
- Import ONLY vitest and the module under test (and the architecture's declared test helpers). No other packages.`;
}

/**
 * Build the prompt for generating a module's behavioral tests FROM ITS SPEC —
 * deliberately WITHOUT the generated implementation, so the tests assert the
 * intended behavior rather than mirroring whatever the code does (independence).
 */
export function buildTestPrompt(
  iu: ImplementationUnit,
  canonNodes: CanonicalNode[],
  importPath: string,
  contract: InterfaceContract | undefined,
  target?: ResolvedTarget | null,
): string {
  const lines: string[] = [];
  lines.push(`Write a vitest behavioral test file for the "${iu.name}" module, from its SPECIFICATION below — NOT its implementation (you are not shown the implementation on purpose).`);
  lines.push('');
  lines.push(`## Import the module under test`);
  lines.push('```');
  lines.push(`import mod from '${importPath}';`);
  lines.push('```');
  lines.push('');

  const iuNodes = canonNodes.filter(n => iu.source_canon_ids.includes(n.canon_id));
  const requirements = iuNodes.filter(n => n.type === 'REQUIREMENT' || n.type === 'CONSTRAINT' || n.type === 'INVARIANT');
  if (requirements.length > 0) {
    lines.push('## Requirements — write at least one assertion for each:');
    for (const r of requirements) lines.push(`- ${r.statement}`);
    lines.push('');
  }

  if (contract && contract.operations.length > 0) {
    lines.push('## Endpoints to exercise (request these ABSOLUTE paths — the router is mounted at its prefix for you):');
    for (const op of contract.operations) {
      const ad = op.address as { method?: string; path?: string } | undefined;
      lines.push(`- ${ad?.method ?? ''} ${ad?.path ?? ''} — ${op.purpose}`);
    }
    if (contract.shape) lines.push(`- shape: ${contract.shape}`);
    lines.push('');
  }

  if (target?.runtime.testGuidance) {
    lines.push('## How to write tests for this architecture:');
    lines.push(target.runtime.testGuidance);
    lines.push('');
  }

  lines.push('Output the complete test module now.');
  return lines.join('\n');
}

export function getUiSystemPrompt(target?: ResolvedTarget | null): string {
  const lang = target?.runtime.language ?? 'TypeScript';
  return `You are a senior ${lang} engineer writing end-to-end UI scenarios with Playwright (@playwright/test).

Rules:
- Output ONLY the Playwright spec module code. No markdown fences, no explanation.
- Drive the RUNNING app through what a USER OBSERVES — do NOT reference or assume the rendered HTML/CSS/DOM structure.
- Every assertion must come from the stated requirements (the spec), not from how the UI happens to be built.
- Assert ONLY via accessibility/visible-text queries (getByRole/getByText/getByLabel/getByPlaceholder). NEVER use CSS selectors, data-testid, page.locator('.class'), or page.$.
- Import ONLY from '@playwright/test'. The base URL is configured; navigate with page.goto('/').`;
}

/**
 * Build the prompt for generating a page's Playwright UI scenarios FROM ITS SPEC —
 * deliberately WITHOUT the generated markup, so scenarios assert observable behavior
 * rather than mirroring the implementation (independence). The dependency API contracts
 * describe the round-trips the page drives (e.g. create → the item appears).
 */
export function buildUiScenarioPrompt(
  iu: ImplementationUnit,
  canonNodes: CanonicalNode[],
  depContracts: InterfaceContract[],
  target?: ResolvedTarget | null,
): string {
  const lines: string[] = [];
  lines.push(`Write a Playwright UI scenario file for the "${iu.name}" page, from its SPECIFICATION below — NOT its implementation (you are not shown the rendered markup on purpose).`);
  lines.push('');
  lines.push('## Import Playwright (include the Page type for any factored-out helper)');
  lines.push('```');
  lines.push(`import { test, expect, type Page } from '@playwright/test';`);
  lines.push('```');
  lines.push('');

  const iuNodes = canonNodes.filter(n => iu.source_canon_ids.includes(n.canon_id));
  const requirements = iuNodes.filter(n => n.type === 'REQUIREMENT' || n.type === 'CONSTRAINT' || n.type === 'INVARIANT');
  if (requirements.length > 0) {
    lines.push('## Observable behaviors — write at least one scenario for each:');
    for (const r of requirements) lines.push(`- ${r.statement}`);
    lines.push('');
  }

  const ops = depContracts.flatMap(c => c.operations);
  if (ops.length > 0) {
    lines.push('## The page drives these API round-trips (act in the UI, then assert the observable result):');
    for (const op of ops) {
      const ad = op.address as { method?: string; path?: string } | undefined;
      lines.push(`- ${ad?.method ?? ''} ${ad?.path ?? ''} — ${op.purpose}`);
    }
    lines.push('');
  }

  if (target?.runtime.uiGuidance) {
    lines.push('## How to write UI scenarios for this architecture:');
    lines.push(target.runtime.uiGuidance);
    lines.push('');
  }

  lines.push('Output the complete Playwright spec module now.');
  return lines.join('\n');
}
