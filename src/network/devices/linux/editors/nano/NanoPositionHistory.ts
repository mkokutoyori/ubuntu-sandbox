export const MAX_POSITION_ENTRIES = 200;

export interface PositionEntry {
  readonly filename: string;
  readonly line: number;
  readonly column: number;
}

function leadingInteger(text: string): number {
  const match = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(text);
  return match === null ? 0 : Number.parseInt(match[1], 10);
}

function lastSpaceAtOrBefore(text: string, index: number): number {
  return index < 0 ? -1 : text.lastIndexOf(' ', index);
}

export function parsePositionHistory(content: string): PositionEntry[] {
  const entries: PositionEntry[] = [];
  let rest = content;
  let counted = 0;
  while (rest.length > 0) {
    const end = rest.indexOf('\n');
    const stanza = (end < 0 ? rest : rest.slice(0, end + 1)).replace(/\0/g, '\n');
    rest = end < 0 ? '' : rest.slice(end + 1);
    if (stanza.length <= 5) break;
    const columnAt = lastSpaceAtOrBefore(stanza, stanza.length - 3);
    if (columnAt < 0) continue;
    const lineAt = lastSpaceAtOrBefore(stanza, columnAt - 2);
    if (lineAt < 0) continue;
    entries.push({
      filename: stanza.slice(0, lineAt),
      line: leadingInteger(stanza.slice(lineAt + 1, columnAt)),
      column: leadingInteger(stanza.slice(columnAt + 1)),
    });
    if (++counted > MAX_POSITION_ENTRIES) entries.shift();
  }
  return entries;
}

export function serializePositionHistory(entries: readonly PositionEntry[]): string {
  return entries.map((entry) => `${entry.filename} ${entry.line} ${entry.column}\n`.replace(/\n(?!$)/g, '\0')).join('');
}

export function findPosition(entries: readonly PositionEntry[], fullPath: string): PositionEntry | null {
  return entries.find((entry) => entry.filename === fullPath) ?? null;
}

export function withPositionRecorded(entries: readonly PositionEntry[], fullPath: string, line: number, column: number, atDefault: boolean): PositionEntry[] | null {
  const existing = entries.findIndex((entry) => entry.filename === fullPath);
  if (atDefault) return existing < 0 ? null : entries.filter((_, index) => index !== existing);
  const kept = existing < 0 ? [...entries] : entries.filter((_, index) => index !== existing);
  kept.push({ filename: fullPath, line, column });
  return kept;
}
