/**
 * Shared parser/formatter for Oracle file sizes ("100M", "2G", …).
 *
 * Tablespace metadata stores sizes as strings to preserve the human
 * representation typed in CREATE TABLESPACE, but views like
 * v$datafile / dba_data_files need to expose them as numeric byte
 * counts so that arithmetic (SUM(bytes)/1024/1024, etc.) actually works.
 */

const UNITS: Record<string, number> = {
  '': 1,
  K: 1024,
  M: 1024 * 1024,
  G: 1024 * 1024 * 1024,
  T: 1024 * 1024 * 1024 * 1024,
};

/** Convert "100M" / "2G" / "1024" to a byte count. Returns 0 on malformed input. */
export function parseSize(size: string | undefined): number {
  if (!size) return 0;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)\s*B?\s*$/i.exec(size);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (UNITS[m[2].toUpperCase()] ?? 1));
}

/** Default Oracle block size in this simulator. */
export const DEFAULT_BLOCK_SIZE = 8192;

/** Number of blocks for a given byte count at the given block size. */
export function bytesToBlocks(bytes: number, blockSize: number = DEFAULT_BLOCK_SIZE): number {
  return Math.floor(bytes / blockSize);
}
