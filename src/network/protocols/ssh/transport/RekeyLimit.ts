export interface RekeyLimit {
  readonly bytes?: number | null;
  readonly seconds?: number | null;
}

export const DEFAULT_REKEY_BLOCKS = 134217728;

const SIZE_UNITS: Readonly<Record<string, number>> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
const TIME_UNITS: Readonly<Record<string, number>> = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

function parseSize(word: string): number | null | undefined {
  if (word === 'default') return undefined;
  if (word === 'none') return null;
  const match = /^(\d+)([KMG]?)$/i.exec(word);
  if (match === null) return undefined;
  const bytes = Number(match[1]) * SIZE_UNITS[match[2].toUpperCase()];
  return bytes > 0 ? bytes : undefined;
}

function parseDuration(word: string): number | null | undefined {
  if (word === 'default' || word === 'none') return null;
  const match = /^(\d+)([smhdw]?)$/i.exec(word);
  if (match === null) return undefined;
  return Number(match[1]) * TIME_UNITS[match[2].toLowerCase()];
}

export function parseRekeyLimit(value: string): RekeyLimit | null {
  const words = value.trim().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0 || words.length > 2) return null;
  const bytes = parseSize(words[0]);
  const seconds = words.length === 2 ? parseDuration(words[1]) : null;
  if (bytes === undefined && words[0] !== 'default') return null;
  if (seconds === undefined) return null;
  return { ...(bytes === undefined ? {} : { bytes }), seconds };
}
