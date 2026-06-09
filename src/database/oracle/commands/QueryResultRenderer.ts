import type { ResultSet } from '../../engine/executor/ResultSet';

export interface ColumnFormat {
  name: string;
  format?: string;
  heading?: string;
  width?: number;
  noprint?: boolean;
}

export interface RenderSettings {
  heading: boolean;
  pagesize: number;
  linesize: number;
  colsep: string;
  underline: string;
  nullDisplay: string;
  wrap: boolean;
}

interface RenderColumn {
  header: string;
  width: number;
  numeric: boolean;
  sourceIndex: number;
  format?: string;
}

const ORACLE_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export class QueryResultRenderer {
  constructor(
    private readonly settings: RenderSettings,
    private readonly columnFormats: ReadonlyMap<string, ColumnFormat>,
  ) {}

  render(result: ResultSet): string[] {
    const plan = this.planColumns(result);
    if (plan.length === 0) return [];

    const cells = result.rows.map(row => plan.map(col => this.renderCell(row[col.sourceIndex], col)));
    const output: string[] = [''];

    if (this.settings.heading) output.push(...this.headerLines(plan));

    let rowCount = 0;
    for (const rowCells of cells) {
      output.push(...this.rowLines(rowCells, plan));
      rowCount++;
      if (this.settings.pagesize > 0 && rowCount % this.settings.pagesize === 0 && rowCount < cells.length) {
        output.push('');
        if (this.settings.heading) output.push(...this.headerLines(plan));
      }
    }

    return output;
  }

  private planColumns(result: ResultSet): RenderColumn[] {
    const plan: RenderColumn[] = [];
    result.columns.forEach((col, i) => {
      const displayName = (col.alias || col.name).toUpperCase();
      const fmt = this.columnFormats.get(displayName);
      if (fmt?.noprint) return;

      const numeric = this.isNumericColumn(result, i);
      const header = fmt?.heading ?? displayName;

      let width = fmt?.width ?? 0;
      if (!width) {
        width = header.length;
        for (const row of result.rows) {
          const len = this.renderValue(row[i], fmt?.format, numeric).length;
          if (len > width) width = len;
        }
      }
      width = Math.max(1, Math.min(width, this.settings.linesize));

      plan.push({ header, width, numeric, sourceIndex: i, format: fmt?.format });
    });
    return plan;
  }

  private headerLines(plan: RenderColumn[]): string[] {
    const headers = plan.map(col => {
      const name = col.header.length > col.width ? col.header.slice(0, col.width) : col.header;
      return col.numeric ? name.padStart(col.width) : name.padEnd(col.width);
    });
    const underline = plan.map(col => this.settings.underline.repeat(col.width));
    return [headers.join(this.settings.colsep), underline.join(this.settings.colsep)];
  }

  private rowLines(rowCells: string[][], plan: RenderColumn[]): string[] {
    const height = Math.max(...rowCells.map(c => c.length));
    const lines: string[] = [];
    for (let lineIdx = 0; lineIdx < height; lineIdx++) {
      const parts = plan.map((col, i) => {
        const text = rowCells[i][lineIdx] ?? '';
        return col.numeric ? text.padStart(col.width) : text.padEnd(col.width);
      });
      lines.push(parts.join(this.settings.colsep));
    }
    return lines;
  }

  private renderCell(value: unknown, col: RenderColumn): string[] {
    const text = this.renderValue(value, col.format, col.numeric);
    if (text.length <= col.width) return [text];
    if (col.numeric) return ['#'.repeat(col.width)];
    if (!this.settings.wrap) return [text.slice(0, col.width)];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += col.width) {
      chunks.push(text.slice(i, i + col.width));
    }
    return chunks;
  }

  private renderValue(value: unknown, format: string | undefined, numeric: boolean): string {
    if (value === null || value === undefined) return this.settings.nullDisplay;
    if (value instanceof Date) return this.formatDate(value);
    if (numeric && format && typeof value === 'number' && this.isNumericMask(format)) {
      return this.applyNumericMask(value, format);
    }
    return String(value);
  }

  private formatDate(value: Date): string {
    const d = value.getDate().toString().padStart(2, '0');
    const m = ORACLE_MONTHS[value.getMonth()];
    const y = (value.getFullYear() % 100).toString().padStart(2, '0');
    return `${d}-${m}-${y}`;
  }

  private isNumericColumn(result: ResultSet, index: number): boolean {
    let sawNumber = false;
    for (const row of result.rows) {
      const v = row[index];
      if (v === null || v === undefined) continue;
      if (typeof v !== 'number') return false;
      sawNumber = true;
    }
    return sawNumber;
  }

  private isNumericMask(format: string): boolean {
    return /^[$]?[09,.]+$/.test(format);
  }

  private applyNumericMask(value: number, mask: string): string {
    const hasDollar = mask.startsWith('$');
    const digitsMask = hasDollar ? mask.slice(1) : mask;
    const dotIndex = digitsMask.indexOf('.');
    const intMask = dotIndex >= 0 ? digitsMask.slice(0, dotIndex) : digitsMask;
    const decMask = dotIndex >= 0 ? digitsMask.slice(dotIndex + 1) : '';
    const intCapacity = (intMask.match(/[09]/g) ?? []).length;
    const negative = value < 0;
    const abs = Math.abs(value);
    const fixed = abs.toFixed(decMask.length);
    const [intPart, decPart] = fixed.split('.');

    if (intPart.length > intCapacity) return '#'.repeat(mask.length + (negative ? 1 : 0));

    const minIntDigits = ((/0/.test(intMask) ? intMask.slice(intMask.indexOf('0')) : '').match(/[09]/g) ?? []).length;
    const paddedInt = intPart.padStart(Math.max(intPart.length, minIntDigits || 1), '0');
    const grouped = intMask.includes(',')
      ? paddedInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      : paddedInt;

    let text = grouped;
    if (decMask.length > 0) text += `.${decPart}`;
    if (hasDollar) text = `$${text}`;
    if (negative) text = `-${text}`;
    return text;
  }
}
