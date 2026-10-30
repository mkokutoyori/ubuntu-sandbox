export type LsFormat = 'single' | 'columns' | 'across' | 'commas' | 'long';

const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
const MIN_COLUMN_WIDTH = 3;
const COLUMN_GAP = 2;

export function lsColumnGeometry(lengths: readonly number[], lineWidth: number, across: boolean): { columns: number; widths: number[] } {
  const count = lengths.length;
  if (count === 0) return { columns: 1, widths: [] };
  const maxColumns = lineWidth === 0 ? count : Math.min(Math.max(1, Math.floor(lineWidth / MIN_COLUMN_WIDTH)), count);
  const widthsFor: number[][] = [];
  const total: number[] = [];
  const valid: boolean[] = [];
  for (let columns = 1; columns <= maxColumns; columns++) {
    widthsFor.push(new Array<number>(columns).fill(MIN_COLUMN_WIDTH));
    total.push(columns * MIN_COLUMN_WIDTH);
    valid.push(true);
  }
  for (let file = 0; file < count; file++) {
    for (let columns = 1; columns <= maxColumns; columns++) {
      const at = columns - 1;
      if (!valid[at]) continue;
      const index = across ? file % columns : Math.floor(file / Math.ceil(count / columns));
      const real = lengths[file] + (index === columns - 1 ? 0 : COLUMN_GAP);
      if (widthsFor[at][index] < real) {
        total[at] += real - widthsFor[at][index];
        widthsFor[at][index] = real;
        valid[at] = lineWidth === 0 || total[at] < lineWidth;
      }
    }
  }
  let columns = maxColumns;
  while (columns > 1 && !valid[columns - 1]) columns--;
  return { columns, widths: widthsFor[columns - 1] };
}

export function lsIndent(from: number, to: number, tabSize: number): string {
  let text = '';
  let position = from;
  while (position < to) {
    if (tabSize !== 0 && Math.floor(to / tabSize) > Math.floor((position + 1) / tabSize)) {
      text += '\t';
      position += tabSize - (position % tabSize);
    } else {
      text += ' ';
      position++;
    }
  }
  return text;
}

export function lsColumns(names: readonly string[], lengths: readonly number[], lineWidth: number, across: boolean, tabSize = 8): string[] {
  const count = names.length;
  if (count === 0) return [];
  const { columns, widths } = lsColumnGeometry(lengths, lineWidth, across);
  const lines: string[] = [];
  if (across) {
    for (let start = 0; start < count; start += columns) {
      let line = '';
      let position = 0;
      for (let at = 0; at < columns && start + at < count; at++) {
        const file = start + at;
        line += names[file];
        position += lengths[file];
        if (start + at + 1 < count && at < columns - 1) {
          const target = position + Math.max(0, widths[at] - lengths[file]);
          line += lsIndent(position, target, tabSize);
          position = target;
        }
      }
      lines.push(line);
    }
    return lines;
  }
  const rows = Math.ceil(count / columns);
  for (let row = 0; row < rows; row++) {
    let line = '';
    let position = 0;
    for (let column = 0; column < columns; column++) {
      const file = row + column * rows;
      if (file >= count) break;
      line += names[file];
      position += lengths[file];
      if (file + rows < count) {
        const target = position + Math.max(0, widths[column] - lengths[file]);
        line += lsIndent(position, target, tabSize);
        position = target;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function lsCommas(names: readonly string[], lengths: readonly number[], lineWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  let position = 0;
  names.forEach((name, index) => {
    if (index > 0) {
      current += ',';
      if (lineWidth === 0 || position + lengths[index] + 2 < lineWidth) {
        current += ' ';
        position += 2;
      } else {
        lines.push(current);
        current = '';
        position = 0;
      }
    }
    current += name;
    position += lengths[index];
  });
  if (current !== '') lines.push(current);
  return lines;
}

export function lsHumanSize(bytes: number, base: 1024 | 1000): string {
  if (bytes < base) return String(bytes);
  const units = base === 1024 ? ['K', 'M', 'G', 'T', 'P', 'E'] : ['k', 'M', 'G', 'T', 'P', 'E'];
  let value = bytes;
  let unit = -1;
  while (value >= base && unit < units.length - 1) {
    value /= base;
    unit++;
  }
  const rounded = value < 10 ? Math.ceil(value * 10) / 10 : Math.ceil(value);
  return `${value < 10 ? rounded.toFixed(1) : String(rounded)}${units[unit]}`;
}

export function lsExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1);
}

export function lsQuoteC(name: string): string {
  const escaped = name.replace(/[\\"]/g, (c) => `\\${c}`)
    .replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

export function lsEscapeNonPrinting(name: string): string {
  return name.replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\\/g, '\\\\');
}

export function lsHideControl(name: string): string {
  return name.replace(CONTROL_CHARACTERS, '?');
}
