const CONTROL_LETTERS: Readonly<Record<string, string>> = { a: '\u0007', f: '\f', v: '\v', t: '\t' };

function takeDigits(source: string, from: number, max: number, pattern: RegExp): string {
  let digits = '';
  while (digits.length < max && from + digits.length < source.length && pattern.test(source[from + digits.length])) digits += source[from + digits.length];
  return digits;
}

export interface DecodedCharacter {
  readonly character: string;
  readonly length: number;
}

export function decodeSedCharacterEscape(source: string, at: number): DecodedCharacter | null {
  const letter = source[at];
  if (letter === undefined) return null;
  if (letter in CONTROL_LETTERS) return { character: CONTROL_LETTERS[letter], length: 1 };
  if (letter === 'c') {
    const target = source[at + 1];
    if (target === undefined) return null;
    return { character: String.fromCharCode(target.toUpperCase().charCodeAt(0) ^ 0x40), length: 2 };
  }
  const base: Record<string, [number, number, RegExp]> = {
    d: [10, 3, /[0-9]/], o: [8, 3, /[0-7]/], x: [16, 2, /[0-9a-fA-F]/],
  };
  if (letter in base) {
    const [radix, width, digit] = base[letter];
    const digits = takeDigits(source, at + 1, width, digit);
    if (digits === '') return null;
    return { character: String.fromCharCode(parseInt(digits, radix) & 0xff), length: 1 + digits.length };
  }
  return null;
}

export function convertSedRegexEscapes(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c !== '\\' || i + 1 >= pattern.length) { out += c; i++; continue; }
    const next = pattern[i + 1];
    if (next === 'n') { out += '\n'; i += 2; continue; }
    const decoded = decodeSedCharacterEscape(pattern, i + 1);
    if (decoded) { out += decoded.character; i += 1 + decoded.length; continue; }
    out += c + next;
    i += 2;
  }
  return out;
}
