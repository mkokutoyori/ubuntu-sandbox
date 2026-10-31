import { parsePlsql } from './PlsqlParser';
import { PlsqlInterpreter } from './PlsqlInterpreter';
import { PlsqlException } from './PlsqlException';
import type { PlsqlHost, Scalar } from './PlsqlValue';

export { PlsqlLexParseError } from './PlsqlLexer';
export { parsePlsql } from './PlsqlParser';
export { PlsqlInterpreter } from './PlsqlInterpreter';
export type { PlsqlHost, StoredUnitLike, Scalar } from './PlsqlValue';
export { compilePackageSection, declarationNames } from './PackageUnit';
export type { PackageSection, PackageRuntimeHandle, PackageSessionState } from './PackageUnit';

export interface PlsqlRunOutcome {
  ok: boolean;
  parseError: boolean;
  /** Compiler diagnostic when parseError is true (PLS-00103 style). */
  parseErrorMessage?: string;
  error: PlsqlException | null;
}

export interface PlsqlVariableRun {
  readonly outcome: PlsqlRunOutcome;
  readonly variables: Map<string, Scalar>;
}

export function runBlockWithVariables(source: string, host: PlsqlHost, preset: ReadonlyMap<string, Scalar>): PlsqlVariableRun {
  const unchanged = new Map(preset);
  let block;
  try {
    block = parsePlsql(source);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { outcome: { ok: false, parseError: true, parseErrorMessage: msg, error: null }, variables: unchanged };
  }
  const interp = new PlsqlInterpreter(host);
  try {
    const variables = interp.runWithVariables(block, preset);
    return { outcome: { ok: true, parseError: false, error: null }, variables };
  } catch (e) {
    if (e instanceof PlsqlException) return { outcome: { ok: false, parseError: false, error: e }, variables: unchanged };
    const msg = e instanceof Error ? e.message : String(e);
    return { outcome: { ok: false, parseError: false, error: new PlsqlException('USER_DEFINED', 6512, msg, false) }, variables: unchanged };
  }
}

export function runAnonymousBlock(source: string, host: PlsqlHost): PlsqlRunOutcome {
  const steps = runAnonymousBlockSteps(source, host);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export function* runAnonymousBlockSteps(source: string, host: PlsqlHost): Generator<void, PlsqlRunOutcome, void> {
  let block;
  try {
    block = parsePlsql(source);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, parseError: true, parseErrorMessage: msg, error: null };
  }
  const interp = new PlsqlInterpreter(host);
  try {
    yield* interp.runSteps(block);
    return { ok: true, parseError: false, error: null };
  } catch (e) {
    if (e instanceof PlsqlException) return { ok: false, parseError: false, error: e };
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, parseError: false, error: new PlsqlException('USER_DEFINED', 6512, msg, false) };
  }
}
