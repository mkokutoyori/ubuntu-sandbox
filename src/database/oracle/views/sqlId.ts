/**
 * Stable 13-char SQL_ID derived from the SQL text — matches Oracle's
 * SQL_ID surface form (lower-case base36).
 */

export function makeSqlId(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  const base = h.toString(36).padStart(7, '0');
  return (base + 'a3xqw0kz').slice(0, 13);
}
