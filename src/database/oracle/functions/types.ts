import type { CellValue } from '../../engine/storage/BaseStorage';

export interface SqlFunctionContext {
  currentUser: string;
  currentSchema: string;
  compare(a: CellValue, b: CellValue): number;
  coerceDate(value: unknown): Date | null;
  formatDate(d: Date): string;
  formatDateWithPattern(d: Date, pattern: string): string;
  parseDateWithPattern(text: string, pattern: string): string;
  userenv(parameter: string): CellValue | undefined;
  metadataDdl(args: CellValue[]): CellValue;
}

export type SqlFunctionImpl = (args: CellValue[], ctx: SqlFunctionContext) => CellValue;

export type SqlFunctionBundle = Record<string, SqlFunctionImpl>;
