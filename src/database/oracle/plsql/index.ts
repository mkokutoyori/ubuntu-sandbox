import { parsePlsql } from './PlsqlParser';
import { PlsqlInterpreter } from './PlsqlInterpreter';
import { PlsqlException } from './PlsqlException';
import type { PlsqlHost } from './PlsqlValue';

export { PlsqlLexParseError } from './PlsqlLexer';
export { parsePlsql } from './PlsqlParser';
export { PlsqlInterpreter } from './PlsqlInterpreter';
export type { PlsqlHost, StoredUnitLike, Scalar } from './PlsqlValue';

export interface PlsqlRunOutcome {
  ok: boolean;
  parseError: boolean;
  /** Compiler diagnostic when parseError is true (PLS-00103 style). */
  parseErrorMessage?: string;
  error: PlsqlException | null;
}

export function runAnonymousBlock(source: string, host: PlsqlHost): PlsqlRunOutcome {
  let block;
  try {
    block = parsePlsql(source);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, parseError: true, parseErrorMessage: msg, error: null };
  }
  const interp = new PlsqlInterpreter(host);
  try {
    interp.run(block);
    return { ok: true, parseError: false, error: null };
  } catch (e) {
    if (e instanceof PlsqlException) return { ok: false, parseError: false, error: e };
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, parseError: false, error: new PlsqlException('USER_DEFINED', 6512, msg, false) };
  }
}
