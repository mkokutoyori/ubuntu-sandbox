import type { Declaration, Stmt, ExceptionHandler } from './PlsqlAst';
import { PlsqlParser } from './PlsqlParser';
import { PlsqlLexParseError } from './PlsqlLexer';
import type { PlsqlCompilationError } from './unitSource';

/** Parsed content of a package spec or body (everything after IS/AS). */
export interface PackageSection {
  declarations: Declaration[];
  initBody: Stmt[];
  initHandlers: ExceptionHandler[];
}

export type PackageSectionCompilation =
  | { ok: true; section: PackageSection }
  | { ok: false; errors: PlsqlCompilationError[] };

/**
 * Compile one package section through the real PL/SQL parser. Failures
 * surface as USER_ERRORS-style rows, like a stored unit compilation —
 * SHOW ERRORS reads them back.
 */
export function compilePackageSection(source: string): PackageSectionCompilation {
  try {
    return { ok: true, section: PlsqlParser.parsePackageSection(source) };
  } catch (e) {
    const line = e instanceof PlsqlLexParseError && e.line > 0 ? e.line : 1;
    const text = e instanceof Error ? e.message : String(e);
    return { ok: false, errors: [{ line, position: 1, text }] };
  }
}

/** Names a declaration contributes to a scope (spec → public surface). */
export function declarationNames(declarations: Declaration[]): Set<string> {
  const names = new Set<string>();
  for (const d of declarations) {
    switch (d.kind) {
      case 'var':
      case 'cursor':
      case 'exception':
      case 'type':
      case 'subprogram':
        names.add(d.name.toUpperCase());
        break;
      default:
        break;
    }
  }
  return names;
}

/**
 * Per-session package instantiation state. Owned by the database (one per
 * session × package); the interpreter populates `scope` lazily on first
 * use and discards it when `version` no longer matches the compiled
 * package — real Oracle's ORA-04068 "state has been discarded".
 *
 * `scope` is typed opaquely so this module stays free of runtime imports.
 */
export interface PackageSessionState {
  version: number;
  scope: unknown | null;
}

/**
 * Runtime view of a user-defined package, handed to the PL/SQL
 * interpreter through PlsqlHost.resolvePackage. Declarations are ordered
 * spec-first so body implementations shadow the spec's forward
 * declarations when the instance scope is built.
 */
export interface PackageRuntimeHandle {
  /** "SCHEMA.PACKAGE" */
  qualifiedName: string;
  /** Bumped on every CREATE OR REPLACE / DROP — invalidates session state. */
  version: number;
  declarations: Declaration[];
  initBody: Stmt[];
  initHandlers: ExceptionHandler[];
  /** Members declared in the spec — the only ones visible from outside. */
  publicNames: Set<string>;
  hasBody: boolean;
  state: PackageSessionState;
}
