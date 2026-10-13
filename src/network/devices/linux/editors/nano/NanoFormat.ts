export type NanoFileFormat = 'unix' | 'dos' | 'mac';

export interface DecodedFile {
  readonly lines: string[];
  readonly format: NanoFileFormat;
  readonly count: number;
}

export const LINE_END: Readonly<Record<NanoFileFormat, string>> = { unix: '\n', dos: '\r\n', mac: '\r' };

export function decodeFile(raw: string, convert: boolean, magicLine: boolean): DecodedFile {
  const lines: string[] = [];
  let format: NanoFileFormat = 'unix';
  let current = '';
  for (const char of raw) {
    if (char === '\n') {
      if (convert && current.endsWith('\r')) {
        if (lines.length === 0) format = 'dos';
        current = current.slice(0, -1);
      }
      lines.push(current);
      current = '';
    } else if (convert && (lines.length === 0 || format === 'mac') && current.endsWith('\r')) {
      format = 'mac';
      lines.push(current.slice(0, -1));
      current = char;
    } else {
      current += char;
    }
  }
  if (current === '') {
    lines.push('');
    return { lines, format, count: lines.length - 1 };
  }
  let endsWithBreak = false;
  if (convert && current.endsWith('\r')) {
    if (lines.length === 0 || format === 'mac') format = 'mac';
    current = current.slice(0, -1);
    endsWithBreak = true;
  }
  lines.push(current);
  if (magicLine || endsWithBreak) lines.push('');
  return { lines, format, count: magicLine || endsWithBreak ? lines.length - 1 : lines.length };
}
