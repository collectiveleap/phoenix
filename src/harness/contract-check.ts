/**
 * Cross-module interface contract check (C3) — the architectural linter extended
 * from static imports to runtime interface edges.
 *
 * Statically verifies that every consumer module only invokes operations a sibling
 * provider actually declares (and, with `--strict`, that providers implement what
 * they declare). Catches the class of bug where a web-ui fetches an address no
 * module serves (outliner `/operations` vs `/outliner-store`) — so a silently-broken
 * UI never ships as "verified" (ties to STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md).
 *
 * Transport-agnostic: all addressing/extraction is delegated to the architecture's
 * `InterfaceDialect`. No dialect ⇒ no runtime contract ⇒ this check is a no-op pass.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ImplementationUnit } from '../models/iu.js';
import type { InterfaceEntry } from '../scaffold.js';
import type { InterfaceDialect, InterfaceContract } from '../models/interface-contract.js';

export interface ContractViolation {
  kind: 'consumer-unresolved' | 'provider-missing';
  module: string;
  detail: string;
}

export interface ContractCheckResult {
  ok: boolean;
  violations: ContractViolation[];
  /** Number of modules/contracts actually checked (0 ⇒ nothing to verify). */
  checked: number;
}

/**
 * Verify the interface contracts across a generated project. Consumer side always;
 * provider conformance when `opts.checkProviders` (Step 5).
 */
export function checkInterfaceContracts(
  projectRoot: string,
  ius: ImplementationUnit[],
  interfaces: InterfaceEntry[],
  dialect: InterfaceDialect | undefined,
  opts: { checkProviders?: boolean } = {},
): ContractCheckResult {
  const violations: ContractViolation[] = [];
  if (!dialect) return { ok: true, violations, checked: 0 };

  const contracts: InterfaceContract[] = interfaces
    .map(e => e.contract)
    .filter((c): c is InterfaceContract => !!c);
  if (contracts.length === 0) return { ok: true, violations, checked: 0 };

  const iuById = new Map(ius.map(iu => [iu.iu_id, iu]));
  const read = (file: string): string | null => {
    const p = join(projectRoot, file);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };

  let checked = 0;

  // Consumer side (C3): every web-ui call must resolve to a declared operation.
  for (const entry of interfaces) {
    if (entry.role !== 'web-ui') continue;
    const iu = iuById.get(entry.iu_id);
    for (const file of iu?.output_files ?? []) {
      const code = read(file);
      if (code === null) continue;
      checked++;
      for (const ref of dialect.extractConsumerCalls(code, contracts)) {
        if (ref.name === null) {
          violations.push({
            kind: 'consumer-unresolved',
            module: entry.name,
            detail: `${entry.name} calls ${ref.raw} — no module serves it`,
          });
        }
      }
    }
  }

  // Provider conformance (Step 5): each provider must implement its declared ops.
  if (opts.checkProviders) {
    for (const entry of interfaces) {
      if (entry.role !== 'api' || !entry.contract) continue;
      const iu = iuById.get(entry.iu_id);
      const code = (iu?.output_files ?? []).map(read).filter((c): c is string => c !== null).join('\n');
      if (!code) continue;
      checked++;
      const implemented = new Set(dialect.extractProviderOps(code, entry.contract).map(r => r.name).filter(Boolean));
      for (const op of entry.contract.operations) {
        if (!implemented.has(op.name)) {
          violations.push({
            kind: 'provider-missing',
            module: entry.name,
            detail: `${entry.name} does not implement declared operation "${op.name}"`,
          });
        }
      }
    }
  }

  return { ok: violations.length === 0, violations, checked };
}
