import type { TypeRef, Block, CursorDecl, SubprogramDecl } from './PlsqlAst';
import { PlsqlException } from './PlsqlException';

export type Scalar = number | string | boolean | null | Date;

export class PlsqlRecord {
  fields: Map<string, Slot> = new Map();
  constructor(public typeName: string) {}
  clone(): PlsqlRecord {
    const r = new PlsqlRecord(this.typeName);
    for (const [k, slot] of this.fields) {
      r.fields.set(k, { type: slot.type, value: cloneValue(slot.value), constant: false });
    }
    return r;
  }
}

export class PlsqlCollection {
  entries: Map<number, PlsqlValue> = new Map();
  constructor(
    public typeName: string,
    public form: 'table' | 'varray' | 'assoc',
    public limit: number | null = null,
  ) {}

  count(): number { return this.entries.size; }

  sortedKeys(): number[] {
    return [...this.entries.keys()].sort((a, b) => a - b);
  }

  first(): number | null {
    const k = this.sortedKeys();
    return k.length ? k[0] : null;
  }
  last(): number | null {
    const k = this.sortedKeys();
    return k.length ? k[k.length - 1] : null;
  }
  next(n: number): number | null {
    const k = this.sortedKeys();
    for (const key of k) if (key > n) return key;
    return null;
  }
  prior(n: number): number | null {
    const k = this.sortedKeys();
    for (let idx = k.length - 1; idx >= 0; idx--) if (k[idx] < n) return k[idx];
    return null;
  }
  exists(n: number): boolean { return this.entries.has(n); }

  clone(): PlsqlCollection {
    const c = new PlsqlCollection(this.typeName, this.form, this.limit);
    for (const [k, v] of this.entries) c.entries.set(k, cloneValue(v));
    return c;
  }
}

export type PlsqlValue = Scalar | PlsqlRecord | PlsqlCollection;

export function cloneValue(v: PlsqlValue): PlsqlValue {
  if (v instanceof PlsqlRecord) return v.clone();
  if (v instanceof PlsqlCollection) return v.clone();
  return v;
}

export interface Slot {
  type: TypeRef;
  value: PlsqlValue;
  constant: boolean;
}

export interface CursorRuntime {
  decl: CursorDecl | null;
  query: string;
  rows: Scalar[][] | null;
  columns: string[];
  position: number;
  isOpen: boolean;
  rowCount: number;
}

export interface RecordTypeDef {
  fields: { name: string; type: TypeRef; init: import('./PlsqlAst').Expr | null }[];
}
export interface CollectionTypeDef {
  form: 'table' | 'varray';
  element: TypeRef;
  indexed: boolean;
  limit: number | null;
}

export class Scope {
  vars: Map<string, Slot> = new Map();
  cursors: Map<string, CursorRuntime> = new Map();
  exceptions: Map<string, { code: number }> = new Map();
  recordTypes: Map<string, RecordTypeDef> = new Map();
  collectionTypes: Map<string, CollectionTypeDef> = new Map();
  cursorDecls: Map<string, CursorDecl> = new Map();
  subprograms: Map<string, SubprogramDecl> = new Map();

  constructor(public parent: Scope | null = null) {}

  child(): Scope { return new Scope(this); }

  declareVar(name: string, slot: Slot): void {
    this.vars.set(name.toUpperCase(), slot);
  }

  findSubprogram(name: string): { decl: SubprogramDecl; scope: Scope } | undefined {
    return walkScopes(this, s => {
      const d = s.subprograms.get(name.toUpperCase());
      return d ? { decl: d, scope: s } : undefined;
    });
  }

  findSlot(name: string): Slot | undefined {
    return walkScopes(this, s => s.vars.get(name.toUpperCase()));
  }

  findCursor(name: string): CursorRuntime | undefined {
    return walkScopes(this, s => s.cursors.get(name.toUpperCase()));
  }

  findCursorDecl(name: string): CursorDecl | undefined {
    return walkScopes(this, s => s.cursorDecls.get(name.toUpperCase()));
  }

  findException(name: string): { code: number } | undefined {
    return walkScopes(this, s => s.exceptions.get(name.toUpperCase()));
  }

  findRecordType(name: string): RecordTypeDef | undefined {
    return walkScopes(this, s => s.recordTypes.get(name.toUpperCase()));
  }

  findCollectionType(name: string): CollectionTypeDef | undefined {
    return walkScopes(this, s => s.collectionTypes.get(name.toUpperCase()));
  }
}

function walkScopes<T>(start: Scope, pick: (s: Scope) => T | undefined): T | undefined {
  let scope: Scope | null = start;
  while (scope) {
    const found = pick(scope);
    if (found !== undefined) return found;
    scope = scope.parent;
  }
  return undefined;
}

export class ExitSignal {
  constructor(public label: string | null) {}
}
export class ContinueSignal {
  constructor(public label: string | null) {}
}
export class ReturnSignal {
  constructor(public value: PlsqlValue) {}
}
export class GotoSignal {
  constructor(public label: string) {}
}

export interface StoredUnitLike {
  schema: string;
  name: string;
  type: 'PROCEDURE' | 'FUNCTION' | 'PACKAGE' | 'PACKAGE BODY' | 'TRIGGER';
  parameters: { name: string; mode: 'IN' | 'OUT' | 'IN OUT'; dataType: string; defaultValue?: string }[];
  returnType?: string;
  body: string;
}

export interface PlsqlHost {
  runSql(sql: string): {
    rows: Scalar[][];
    columns: string[];
    isQuery: boolean;
    affectedRows?: number;
    message?: string;
  };
  putLine(text: string): void;
  put(text: string): void;
  isServerOutput(): boolean;
  currentSchema(): string;
  lookupUnit(name: string): StoredUnitLike | undefined;
  /**
   * Resolve a user-defined package by name ("PKG" or "SCHEMA.PKG").
   * Returns undefined when no such package is visible to the caller —
   * the interpreter then falls back to its other resolution paths.
   */
  resolvePackage?(name: string): import('./PackageUnit').PackageRuntimeHandle | undefined;
  callBuiltin(name: string, rawArgsText: string, evaluatedArgs: PlsqlValue[]): boolean;
  /** Server-side file I/O backing the UTL_FILE package, when available. */
  utlFile?: UtlFileApi;
  beginAutonomousScope?(): void;
  endAutonomousScope?(): void;
}

/**
 * The UTL_FILE surface the interpreter drives. Handles are opaque
 * integers (Oracle's FILE_TYPE is a record the PL/SQL code only passes
 * around). Operations throw OracleError with the canonical ORA codes so
 * the interpreter can surface them as catchable PL/SQL exceptions
 * (e.g. NO_DATA_FOUND at end-of-file).
 */
export interface UtlFileApi {
  /** Open `filename` in directory object `dir` with mode R/W/A. */
  fopen(dir: string, filename: string, mode: string, maxLineSize?: number): number;
  isOpen(handle: number): boolean;
  /** Next line of a read-mode file; ORA-01403 (NO_DATA_FOUND) at EOF. */
  getLine(handle: number): string;
  putLine(handle: number, text: string): void;
  put(handle: number, text: string): void;
  newLine(handle: number, count: number): void;
  fflush(handle: number): void;
  fclose(handle: number): void;
  fcloseAll(): void;
  fremove(dir: string, filename: string): void;
  frename(srcDir: string, srcFile: string, destDir: string, destFile: string, overwrite: boolean): void;
  fcopy(srcDir: string, srcFile: string, destDir: string, destFile: string): void;
}

export function isTrue(v: PlsqlValue): boolean {
  return v === true;
}

export function raisePredefinedByName(_name: string): never {
  throw new PlsqlException('PROGRAM_ERROR', 6501, 'ORA-06501: PL/SQL: program error');
}

export { Block };
