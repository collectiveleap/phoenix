/**
 * Interface Contract — the deterministic boundary between internal modules at
 * runtime (a sibling reached over the wire, not via a static import).
 *
 * This is the missing quadrant of Phoenix's boundary model: internal-static deps
 * are governed by `code.allowed_ius`, external deps by `side_channels` + the env
 * contract, but a module-to-module RUNTIME interface (a web-ui calling a resource
 * module) had no declared, enforced contract — so a consumer could invent an
 * address the provider doesn't serve (the outliner `/operations` vs `/outliner-store`
 * 404). See change-notes/CROSS-MODULE-CONTRACT-DIAGNOSIS.md.
 *
 * The model here is TRANSPORT-NEUTRAL: an interface is a set of named operations
 * with a shape and a hash. HOW an operation is addressed and invoked (REST URL +
 * method, an RPC method name, a message topic, a CRDT collection) is the concern
 * of an architecture-supplied `InterfaceDialect` — never of this core. A REST
 * architecture and an all-in-browser P2P architecture share this contract; they
 * differ only in their dialect.
 */

import type { ImplementationUnit } from './iu.js';
import type { CanonicalNode } from './canonical.js';
import { sha256 } from '../semhash.js';

/** A single operation a provider module exposes (transport-neutral). */
export interface OperationSpec {
  /** Stable operation name, e.g. 'list', 'append', 'get', 'update', 'delete'. */
  name: string;
  /** Human purpose, used in prompts and diagnostics. */
  purpose: string;
  /** Optional input/output shape descriptions (free text or a type reference). */
  input?: string;
  output?: string;
  /**
   * Dialect-specific addressing, opaque to the core. REST: `{ method, path }`;
   * P2P/in-browser: `{ topic }` or `{ fn }`. Included in the contract hash so a
   * change to addressing invalidates dependents.
   */
  address?: unknown;
}

/** The interface a provider IU exposes — the contract its consumers bind to. */
export interface InterfaceContract {
  iu_id: string;
  /** Stable interface identity (the provider's logical name). */
  identity: string;
  /** Operations the provider exposes. */
  operations: OperationSpec[];
  /** Resource / data shape description (free text). */
  shape: string;
  /** Hash over identity + operations + shape — drives selective invalidation. */
  contract_hash: string;
}

/**
 * A reference to an operation as found in generated code — either a consumer
 * invocation or a provider implementation.
 */
export interface OpRef {
  /** The resolved operation name, or null when the address matches no operation. */
  name: string | null;
  /** The raw address as written in code (REST: the URL; P2P: the topic/fn) — for diagnostics + repair. */
  raw: string;
}

/**
 * Architecture-supplied translation between the neutral contract and a concrete
 * transport. The core orchestrates the four boundary operations (declare →
 * generate-against → verify → invalidate); the dialect renders/extracts them.
 *
 * An architecture with no runtime decoupling (one bundle, direct imports) supplies
 * no dialect — the internal-static boundary (`allowed_ius`) already covers it.
 */
export interface InterfaceDialect {
  /** Declare: derive the operations a provider IU exposes (e.g. CRUD routes). */
  deriveOperations(iu: ImplementationUnit, canonNodes: CanonicalNode[]): OperationSpec[];
  /** Declare: render a contract for the consumer-generation prompt. */
  describeForPrompt(contract: InterfaceContract): string;
  /** Generate-against: consumer-side client file(s) — relative path → content. */
  generateClient(contracts: InterfaceContract[]): Record<string, string>;
  /** Generate-against: deterministically repair mis-addressed consumer calls where resolvable. */
  bindConsumer(code: string, contracts: InterfaceContract[]): string;
  /**
   * Verify (consumer): the operations a consumer module invokes, each resolved
   * against the provider contracts. `name === null` ⇒ the call addresses no
   * declared operation (a broken cross-module call).
   */
  extractConsumerCalls(code: string, contracts: InterfaceContract[]): OpRef[];
  /**
   * Verify (provider): which of a provider contract's operations the provider
   * module actually implements, resolved against that contract. A contract
   * operation absent from the result is a conformance gap.
   */
  extractProviderOps(code: string, contract: InterfaceContract): OpRef[];
}

/**
 * Compute the transport-neutral contract hash. Deterministic over the operation
 * order the dialect produces, so an unchanged interface hashes identically and a
 * route/shape change flips it (driving consumer invalidation).
 */
export function hashContract(identity: string, operations: OperationSpec[], shape: string): string {
  return sha256(JSON.stringify({ identity, operations, shape }));
}

/** Build a full contract from a dialect's derived operations. */
export function makeContract(
  iu_id: string,
  identity: string,
  operations: OperationSpec[],
  shape: string,
): InterfaceContract {
  return { iu_id, identity, operations, shape, contract_hash: hashContract(identity, operations, shape) };
}
