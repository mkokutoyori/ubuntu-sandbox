import { parsePlsql } from './PlsqlParser';
import { PlsqlLexParseError } from './PlsqlLexer';
import type { StoredUnitLike } from './PlsqlValue';

export interface PlsqlCompilationError {
  line: number;
  position: number;
  text: string;
}

export interface UnitCompilationResult {
  ok: boolean;
  errors: PlsqlCompilationError[];
}

export function buildSubprogramSource(unit: StoredUnitLike): string {
  const params = unit.parameters
    .map(p => `${p.name} ${p.mode} ${p.dataType}${p.defaultValue ? ' DEFAULT ' + p.defaultValue : ''}`)
    .join(', ');
  const header = unit.type === 'FUNCTION'
    ? `FUNCTION ${unit.name}${params ? '(' + params + ')' : ''} RETURN ${unit.returnType} IS `
    : `PROCEDURE ${unit.name}${params ? '(' + params + ')' : ''} IS `;
  const body = unit.body.trim().replace(/;+\s*$/, '');
  if (/^DECLARE\b/i.test(body)) {
    return header + body.replace(/^DECLARE/i, '') + ';';
  }
  if (/\bBEGIN\b/i.test(body)) {
    return header + body + ';';
  }
  return header + 'BEGIN ' + body + '; END;';
}

export function compileStoredUnit(unit: StoredUnitLike): UnitCompilationResult {
  if (unit.type !== 'PROCEDURE' && unit.type !== 'FUNCTION') {
    return { ok: true, errors: [] };
  }
  try {
    parsePlsql(`DECLARE ${buildSubprogramSource(unit)} BEGIN NULL; END;`);
    return { ok: true, errors: [] };
  } catch (e) {
    const line = e instanceof PlsqlLexParseError && e.line > 0 ? e.line : 1;
    const text = e instanceof Error ? e.message : String(e);
    return { ok: false, errors: [{ line, position: 1, text }] };
  }
}
