/**
 * sanitizeFilename — make any user-provided string safe for use as a
 * download attribute on an <a> tag (or any other write-to-disk path the
 * browser/host honours).
 *
 * Rules:
 *   - Replace runs of any character outside [A-Za-z0-9._-] with one underscore.
 *   - Strip leading/trailing dots so the result never resembles a UNIX
 *     hidden file or path-traversal segment ("..").
 *   - Cap the length at 64 bytes.
 *   - Fall back to `fallback` (default: "file") if the cleaned name is empty.
 */
export function sanitizeFilename(raw: string, fallback: string = 'file'): string {
  if (typeof raw !== 'string') return fallback;
  // Replace runs of unsafe chars with a single underscore.
  let cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '_');
  // Collapse repeated underscores.
  cleaned = cleaned.replace(/_+/g, '_');
  // Strip leading/trailing dots and underscores. Trim NUL/space etc.
  cleaned = cleaned.replace(/^[._-]+|[._-]+$/g, '');
  // Cap length.
  if (cleaned.length > 64) cleaned = cleaned.slice(0, 64);
  return cleaned.length > 0 ? cleaned : fallback;
}
