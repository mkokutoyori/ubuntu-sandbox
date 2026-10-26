export const ROWS_PER_BLOCK = 8;

export function blocksOfRows(rowCount: number): number {
  return Math.max(1, Math.ceil(rowCount / ROWS_PER_BLOCK));
}
