const IEC_FACTORS: ReadonlyArray<readonly [string, bigint]> = [
  ['E', 1024n ** 6n], ['P', 1024n ** 5n], ['T', 1024n ** 4n], ['G', 1024n ** 3n], ['M', 1024n ** 2n], ['K', 1024n], ['B', 1n], ['', 1n],
];
const SI_FACTORS: ReadonlyArray<readonly [string, bigint]> = [
  ['E', 1000n ** 6n], ['P', 1000n ** 5n], ['T', 1000n ** 4n], ['G', 1000n ** 3n], ['M', 1000n ** 2n], ['K', 1000n], ['B', 1n], ['', 1n],
];
const WHITESPACE = ' \t\n\r';
const UINT64_MAX = 2n ** 64n - 1n;

export function parseSize(text: string, base: 1000 | 1024): number | null {
  const table = base === 1000 ? SI_FACTORS : IEC_FACTORS;
  let at = 0;
  let startPosition = 0;
  let total = 0n;
  do {
    while (at < text.length && WHITESPACE.includes(text[at])) at++;
    const digits = /^\d+/.exec(text.slice(at));
    if (digits === null || text[at] === '-') return null;
    const whole = BigInt(digits[0]);
    let cursor = at + digits[0].length;
    let fraction = 0;
    if (text[cursor] === '.') {
      cursor++;
      const decimals = /^\d+/.exec(text.slice(cursor));
      if (decimals !== null) {
        fraction = Number(`0.${decimals[0]}`);
        cursor += decimals[0].length;
      }
    }
    while (cursor < text.length && WHITESPACE.includes(text[cursor])) cursor++;
    let index = startPosition;
    while (index < table.length && !text.startsWith(table[index][0], cursor)) index++;
    if (index >= table.length) return null;
    const [suffix, factor] = table[index];
    if (whole + (fraction > 0 ? 1n : 0n) > UINT64_MAX / factor) return null;
    const piece = whole * factor + BigInt(Math.floor(fraction * Number(factor)));
    if (piece > UINT64_MAX - total) return null;
    total += piece;
    at = cursor + suffix.length;
    startPosition = index + 1;
  } while (at < text.length);
  return Number(total);
}
