export interface Strtol {
  readonly value: number;
  readonly rest: string;
  readonly consumed: boolean;
}

export function strtol(text: string, base = 10): Strtol {
  const match = base === 10
    ? /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(text)
    : /^[ \t\n\v\f\r]*([+-]?(?:0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*))/.exec(text);
  if (match === null) return { value: 0, rest: text, consumed: false };
  const digits = match[1];
  const negative = digits.startsWith('-');
  const unsigned = digits.replace(/^[+-]/, '');
  let magnitude: number;
  if (base === 10) magnitude = Number.parseInt(unsigned, 10);
  else if (/^0[xX]/.test(unsigned)) magnitude = Number.parseInt(unsigned, 16);
  else if (unsigned.length > 1 && unsigned.startsWith('0')) magnitude = Number.parseInt(unsigned, 8);
  else magnitude = Number.parseInt(unsigned, 10);
  return { value: negative ? -magnitude : magnitude, rest: text.slice(match[0].length), consumed: true };
}

export function strtolWhole(text: string, base = 10): number | null {
  const parsed = strtol(text, base);
  return parsed.consumed && parsed.rest === '' ? parsed.value : null;
}

export function atoux(text: string): number | null {
  if (text.startsWith('-')) return null;
  const whole = strtolWhole(text, 0);
  if (whole === null) return null;
  return whole > 0xffffffff ? null : whole;
}

export function sscanfInt(text: string, alternateBases: boolean): number | null {
  const parsed = strtol(text, alternateBases ? 0 : 10);
  return parsed.consumed ? parsed.value : null;
}

export function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function strcasecmp(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function startsWithIgnoreCase(text: string, prefix: string): boolean {
  return text.length >= prefix.length && text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}
