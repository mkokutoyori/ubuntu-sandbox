/**
 * RmanTag — Oracle backup tag value object.
 *
 * Format: TAG<yyyymmdd>T<hhmmss>. Generated from a Date so tests can
 * inject a deterministic value; user-provided tags are uppercased.
 */

export interface RmanTag {
  readonly _tag:  'RmanTag';
  readonly label: string;
}

export const RmanTag = {
  generate(now: Date = new Date()): RmanTag {
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const label =
      `TAG${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return Object.freeze({ _tag: 'RmanTag' as const, label });
  },
  of(label: string): RmanTag {
    return Object.freeze({ _tag: 'RmanTag' as const, label: label.toUpperCase() });
  },
  toString: (t: RmanTag): string => t.label,
};
