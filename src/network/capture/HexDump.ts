export interface HexRow {
  readonly offset: number;
  readonly bytes: readonly number[];
  readonly ascii: string;
}

export function hexRows(bytes: readonly number[], width = 16): HexRow[] {
  const rows: HexRow[] = [];
  for (let offset = 0; offset < bytes.length; offset += width) {
    const row = bytes.slice(offset, offset + width);
    const ascii = row.map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.')).join('');
    rows.push({ offset, bytes: row, ascii });
  }
  return rows;
}

export function hexGroups(bytes: readonly number[], groupSize: number, separator: string): string {
  const groups: string[] = [];
  for (let index = 0; index < bytes.length; index += groupSize) {
    groups.push(bytes.slice(index, index + groupSize).map((byte) => byte.toString(16).padStart(2, '0')).join(''));
  }
  return groups.join(separator);
}
