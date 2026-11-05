export interface BlockScale {
  readonly unit: number;
  readonly suffix: string;
}

const UNIT_POWERS: Readonly<Record<string, number>> = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6, Z: 7, Y: 8, R: 9, Q: 10 };

export function parseBlockSize(text: string): BlockScale | null {
  const match = /^(\d*)([KMGTPEZYRQ]?)(i?B)?$/i.exec(text);
  if (!match || (match[1] === '' && match[2] === '')) return null;
  const power = match[2] === '' ? 0 : UNIT_POWERS[match[2].toUpperCase()];
  const decimal = match[3] !== undefined && match[3].toUpperCase() === 'B' && match[2] !== '';
  const binary = match[3] !== undefined && match[3].toLowerCase() === 'ib' && match[2] !== '';
  const base = decimal ? 1000 : 1024;
  const count = match[1] === '' ? 1 : Number(match[1]);
  if (count === 0) return null;
  const unit = count * base ** power;
  const suffix = match[1] === '' && power > 0 ? `${match[2].toUpperCase()}${decimal ? 'B' : binary ? 'iB' : ''}`.replace(/^K(B)$/, 'k$1') : '';
  return { unit, suffix };
}

export function scaledSize(bytes: number, scale: BlockScale): string {
  return `${Math.ceil(bytes / scale.unit)}${scale.suffix}`;
}
