/**
 * RlsPredicateApplier — Virtual Private Database predicates, applied.
 *
 * `DBMS_RLS.ADD_POLICY` names a function that returns a WHERE fragment.
 * Oracle calls it when the object is accessed and ANDs what it returns
 * into the statement; this module does the same. Several policies on one
 * object all apply, joined by AND — a policy can only ever narrow.
 *
 * The predicate arrives as text, so it is re-parsed into an expression
 * the executor already knows how to evaluate, the same way
 * `ConstraintValidator` re-parses a stored CHECK clause. A predicate that
 * does not parse raises ORA-28113 rather than being dropped: a security
 * filter that silently disappears is worse than a failed query.
 *
 * Exemptions are Oracle's: `SYS`, and anyone holding `EXEMPT ACCESS
 * POLICY`. The object's own owner is **not** exempt — that is the classic
 * VPD surprise, and reproducing it is the point.
 *
 * On a write the predicate does two different jobs. It always narrows
 * which existing rows `UPDATE`/`DELETE` may reach — you cannot change
 * what you cannot see. Separately, `update_check` makes the *resulting*
 * row have to satisfy the predicate too, so an `INSERT` or `UPDATE`
 * cannot push a row somewhere its author would no longer be allowed to
 * read it (ORA-28115). Only policies carrying that argument take part in
 * the second job, which is what `onlyWithCheckOption` selects.
 */

import type { Expression, SelectStatement } from '../../engine/parser/ASTNode';
import type { CellValue } from '../../engine/storage/BaseStorage';
import { OracleError } from '../../engine/types/DatabaseError';
import { OracleLexer } from '../OracleLexer';
import { OracleParser } from '../OracleParser';

/** Which statement the object is being reached by. */
export type RlsOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface RlsPolicyRecord {
  objectOwner: string;
  objectName: string;
  policyName: string;
  pfOwner: string;
  pfPackage: string | null;
  pfFunction: string;
  statementTypes: { sel: boolean; ins: boolean; upd: boolean; del: boolean; idx: boolean };
  enabled: boolean;
  secRelevantCols: string[];
  updateCheck: boolean;
}

/**
 * Columns the statement references on the object, when that is known.
 * `undefined` means "not determined" and arms every policy — a column
 * relevance that cannot be established must not disarm a filter.
 */
export type ReferencedColumns = ReadonlySet<string> | undefined;

export interface RlsHost {
  /** Policies registered on any object, read live from the catalog. */
  policies(): readonly RlsPolicyRecord[];
  /** The user the statement runs as. */
  currentUser(): string;
  /** True when the user holds EXEMPT ACCESS POLICY. */
  isExempt(user: string): boolean;
  /** Invoke the policy function; `handled: false` when it does not exist. */
  callFunction(qualifiedName: string, args: CellValue[]): { handled: boolean; value: CellValue };
}

const predicateCache = new Map<string, Expression | null>();
const PREDICATE_CACHE_MAX = 512;

/**
 * Re-parse a predicate fragment. `null` marks text that does not parse,
 * cached like a successful parse so a broken policy is not re-lexed on
 * every row source.
 */
function parsePredicate(text: string): Expression | null {
  const cached = predicateCache.get(text);
  if (cached !== undefined) return cached;
  let where: Expression | null = null;
  try {
    const tokens = new OracleLexer().tokenize(`SELECT 1 FROM DUAL WHERE ${text}`);
    const stmt = new OracleParser().parse(tokens) as SelectStatement;
    where = stmt.where ?? null;
  } catch {
    where = null;
  }
  if (predicateCache.size >= PREDICATE_CACHE_MAX) {
    const oldest = predicateCache.keys().next().value;
    if (oldest !== undefined) predicateCache.delete(oldest);
  }
  predicateCache.set(text, where);
  return where;
}

function appliesTo(policy: RlsPolicyRecord, operation: RlsOperation): boolean {
  switch (operation) {
    case 'SELECT': return policy.statementTypes.sel;
    case 'INSERT': return policy.statementTypes.ins;
    case 'UPDATE': return policy.statementTypes.upd;
    case 'DELETE': return policy.statementTypes.del;
  }
}

/**
 * Guards against a policy function that reads the very object it
 * protects: the nested access would call it again, without end. Oracle
 * raises ORA-28108 for the equivalent loop; the set below simply stops
 * re-entering, leaving the inner read unfiltered rather than hanging.
 */
const evaluating = new Set<string>();

/**
 * A policy naming `sec_relevant_cols` only arms when the statement
 * actually references one of those columns — column-level VPD. A policy
 * that names none arms unconditionally.
 */
function isRelevant(policy: RlsPolicyRecord, referenced: ReferencedColumns): boolean {
  if (policy.secRelevantCols.length === 0) return true;
  if (referenced === undefined) return true;
  return policy.secRelevantCols.some(c => referenced.has(c));
}

/**
 * The predicate guarding `schema.object` for this statement, or `null`
 * when nothing applies. Several policies are ANDed together.
 */
export function resolveRlsPredicate(
  host: RlsHost,
  schema: string,
  objectName: string,
  operation: RlsOperation,
  referenced: ReferencedColumns = undefined,
  onlyWithCheckOption = false,
): Expression | null {
  const user = host.currentUser();
  if (user === 'SYS' || host.isExempt(user)) return null;

  const owner = schema.toUpperCase();
  const obj = objectName.toUpperCase();
  const key = `${owner}.${obj}`;
  if (evaluating.has(key)) return null;

  const applicable = host.policies().filter(p =>
    p.enabled && p.objectOwner === owner && p.objectName === obj
    && appliesTo(p, operation) && isRelevant(p, referenced)
    && (!onlyWithCheckOption || p.updateCheck));
  if (applicable.length === 0) return null;

  const parts: Expression[] = [];
  evaluating.add(key);
  try {
    for (const policy of applicable) {
      const fn = policy.pfPackage
        ? `${policy.pfOwner}.${policy.pfPackage}.${policy.pfFunction}`
        : `${policy.pfOwner}.${policy.pfFunction}`;
      const called = host.callFunction(fn, [owner, obj]);
      if (!called.handled) {
        throw new OracleError(28113, `policy predicate has error for policy ${policy.policyName}`);
      }
      const text = called.value === null || called.value === undefined ? '' : String(called.value);
      if (text.trim() === '') continue;
      const parsed = parsePredicate(text);
      if (!parsed) {
        throw new OracleError(28113, `policy predicate has error for policy ${policy.policyName}`);
      }
      parts.push(parsed);
    }
  } finally {
    evaluating.delete(key);
  }

  if (parts.length === 0) return null;
  return parts.reduce((left, right) => ({
    type: 'BinaryExpr', operator: 'AND', left, right,
  } as Expression));
}

/** Drops the parsed-predicate cache. Test seam. */
export function resetRlsPredicateCache(): void {
  predicateCache.clear();
  evaluating.clear();
}
