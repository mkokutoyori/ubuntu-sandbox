/**
 * chainWalk — glibc's `[STATUS=action]` walk, in one place.
 *
 * This is the rule that decides, source by source, whether a lookup stops
 * or carries on: each source's outcome (SUCCESS / NOTFOUND / UNAVAIL /
 * TRYAGAIN) is looked up in that source's own action table, and the answer
 * says `return`, `continue` or `merge`. Defaults are SUCCESS=return,
 * NOTFOUND=continue, UNAVAIL=continue, TRYAGAIN=continue.
 *
 * It lives on its own because there are two callers who must not drift
 * apart, and who used to have a copy each:
 *
 *   - `NameServiceSwitch` — what `getent`, `ping` and the resolver ask;
 *   - `LinuxUserManager` — the account model `id`, `su` and every
 *     permission check consult.
 *
 * Two implementations of the same rule is two chances to disagree, and a
 * machine where `getent passwd alice` and `id alice` answer differently is
 * worse than one where both are wrong: nothing in the diagnosis adds up.
 *
 * The walk is deliberately shaped as a small state object rather than a
 * function over a list, because the callers feed it differently — one
 * queries live sources (possibly asynchronously), the other already holds
 * each source's whole table. Both drive the same `step`/`finish` pair.
 */

import type { NssResult, NssSourceSpec, NssStatus } from './types';
import { effectiveAction } from './NssConfig';

/** How two answers for the same key combine under `[SUCCESS=merge]`. */
export type NssMerge<T> = (a: T, b: T) => T;

/**
 * glibc implements `merge` for the group database, where it unions the
 * member lists. Arrays concatenate; anything else keeps the first answer,
 * which is what `continue` would have done anyway.
 */
export function defaultNssMerge<T>(a: T, b: T): T {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b] as unknown as T;
  return a;
}

export interface NssWalk<T> {
  /** Feed one source's outcome. Returns the final result if the walk stops here. */
  step(spec: NssSourceSpec, r: NssResult<T>): NssResult<T> | null;
  /** The result when every source has been consulted without stopping. */
  finish(): NssResult<T>;
}

/**
 * Start a walk for one key.
 *
 * `finish()` reports NOTFOUND over UNAVAIL when both were seen, because a
 * source that answered "no such name" is a more specific fact than one that
 * could not answer at all.
 */
export function startNssWalk<T>(merge: NssMerge<T> = defaultNssMerge): NssWalk<T> {
  let sawNotFound = false;
  let sawUnavail = false;
  let collected: T | undefined;
  /** The previous success said `merge`, so the next one adds to it. */
  let mergePending = false;

  return {
    step(spec: NssSourceSpec, r: NssResult<T>): NssResult<T> | null {
      if (r.status === 'NOTFOUND') sawNotFound = true;
      if (r.status === 'UNAVAIL') sawUnavail = true;

      const action = effectiveAction(spec, r.status);

      if (r.status === 'SUCCESS' && r.entry !== undefined) {
        // The three SUCCESS actions differ precisely here:
        //   return   — settle now, nothing further is asked (the default);
        //   merge    — keep what we have and combine the next answer in;
        //   continue — discard what we have; a later answer replaces it,
        //              which is glibc's last-wins.
        collected = collected !== undefined && mergePending
          ? merge(collected, r.entry)
          : r.entry;
        mergePending = action === 'merge';
        if (action === 'return') return { status: 'SUCCESS', entry: collected };
        return null;
      }
      if (action === 'return') {
        // A `return` on NOTFOUND/UNAVAIL ends the chain: whatever was
        // already collected is the answer, and nothing further is asked.
        return collected === undefined ? r : { status: 'SUCCESS', entry: collected };
      }
      return null;
    },
    finish(): NssResult<T> {
      if (collected !== undefined) return { status: 'SUCCESS', entry: collected };
      const status: NssStatus = sawNotFound ? 'NOTFOUND' : sawUnavail ? 'UNAVAIL' : 'NOTFOUND';
      return { status };
    },
  };
}
