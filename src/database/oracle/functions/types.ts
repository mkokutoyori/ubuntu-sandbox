/**
 * SQL scalar function registry types.
 *
 * Each built-in Oracle SQL function (UPPER, NVL, TO_CHAR, DBMS_RANDOM.VALUE…)
 * is a self-contained `SqlFunction` registered by name. The executor resolves
 * the call and supplies an evaluation context — adding a function never
 * requires touching the executor again (Open/Closed).
 */

import type { CellValue } from '../../engine/storage/BaseStorage';
import type { Expression } from '../../engine/parser/ASTNode';

export interface SqlFunctionCall {
  /** Uppercased function name (e.g. `SUBSTR`). */
  readonly name: string;
  /** Uppercased package/schema qualifier when present (e.g. `DBMS_RANDOM`). */
  readonly schema?: string;
  /** Eagerly evaluated argument values. */
  readonly args: CellValue[];
  /** Raw argument AST — needed for COUNT(*) Star detection. */
  readonly rawArgs: readonly Expression[];
}

export interface SqlFunctionContext {
  readonly currentUser: string;
  readonly currentSchema: string;
  /** USERENV attribute provider from the live OracleSession, when attached. */
  readonly userenv?: (param: string) => unknown;
  /** DBMS_METADATA.GET_DDL delegate — needs storage/catalog access. */
  readonly getMetadataDDL: (args: CellValue[]) => CellValue;
}

export type SqlFunction = (call: SqlFunctionCall, ctx: SqlFunctionContext) => CellValue;
