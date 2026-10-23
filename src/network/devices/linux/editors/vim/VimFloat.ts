interface ExactDecimal {
  readonly negative: boolean;
  readonly digits: string;
  readonly scale: number;
}

function exactDecimal(value: number): ExactDecimal {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & 0xfffffffffffffn;
  let exponent = -1074;
  if (exponentBits !== 0) {
    mantissa |= 1n << 52n;
    exponent = exponentBits - 1075;
  }
  if (mantissa === 0n) return { negative, digits: '0', scale: 0 };
  if (exponent >= 0) return { negative, digits: (mantissa << BigInt(exponent)).toString(), scale: 0 };
  return { negative, digits: (mantissa * 5n ** BigInt(-exponent)).toString(), scale: -exponent };
}

function roundHalfEven(digits: string, keep: number): string {
  if (keep >= digits.length) return digits.padEnd(keep, '0');
  const kept = digits.slice(0, keep);
  const rest = digits.slice(keep);
  const first = rest.charCodeAt(0) - 48;
  const tail = /[1-9]/.test(rest.slice(1));
  let up = first > 5 || (first === 5 && tail);
  if (first === 5 && !tail) up = kept.length > 0 && (kept.charCodeAt(kept.length - 1) - 48) % 2 === 1;
  if (!up) return kept;
  return (BigInt(kept === '' ? '0' : kept) + 1n).toString().padStart(kept.length, '0');
}

function signOf(negative: boolean): string {
  return negative ? '-' : '';
}

export function formatFixed(value: number, decimals: number): string {
  const { negative, digits, scale } = exactDecimal(value);
  const padded = digits.padStart(scale + 1, '0');
  const integerLength = padded.length - scale;
  const rounded = roundHalfEven(padded, integerLength + decimals);
  const whole = rounded.slice(0, rounded.length - decimals) || '0';
  const fraction = rounded.slice(rounded.length - decimals);
  const body = decimals > 0 ? `${whole}.${fraction}` : whole;
  return signOf(negative) + body;
}

interface ExponentialParts {
  readonly negative: boolean;
  readonly mantissa: string;
  readonly exponent: number;
}

function exponentialParts(value: number, decimals: number): ExponentialParts {
  const { negative, digits, scale } = exactDecimal(value);
  if (digits === '0') return { negative, mantissa: decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0', exponent: 0 };
  let exponent = digits.length - 1 - scale;
  let significant = roundHalfEven(digits, decimals + 1);
  if (significant.length > decimals + 1) {
    significant = significant.slice(0, decimals + 1);
    exponent++;
  }
  const mantissa = decimals > 0 ? `${significant[0]}.${significant.slice(1)}` : significant;
  return { negative, mantissa, exponent };
}

export function formatExponential(value: number, decimals: number, upper: boolean): string {
  const { negative, mantissa, exponent } = exponentialParts(value, decimals);
  const sign = exponent < 0 ? '-' : '+';
  const magnitude = String(Math.abs(exponent)).padStart(2, '0');
  return `${signOf(negative)}${mantissa}${upper ? 'E' : 'e'}${sign}${magnitude}`;
}

function stripTrailingZeros(text: string): string {
  if (!text.includes('.')) return `${text}.0`;
  const stripped = text.replace(/0+$/, '');
  return stripped.endsWith('.') ? `${stripped}0` : stripped;
}

function nonFinite(value: number): string | null {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  return null;
}

export function formatVimGeneral(value: number, decimals: number, strip: boolean, upper: boolean): string {
  const special = nonFinite(value);
  if (special !== null) return special;
  const magnitude = Math.abs(value);
  const exponential = magnitude >= 1e7 || (magnitude !== 0 && magnitude < 1e-3);
  if (!exponential) {
    const fixed = formatFixed(value, decimals);
    return strip ? stripTrailingZeros(fixed) : fixed;
  }
  const { negative, mantissa, exponent } = exponentialParts(value, decimals);
  const shown = strip ? stripTrailingZeros(mantissa) : mantissa;
  return `${signOf(negative)}${shown}${upper ? 'E' : 'e'}${exponent}`;
}

export function formatFloatDefault(value: number): string {
  return formatVimGeneral(value, 6, true, false);
}

export function formatFixedSafe(value: number, decimals: number): string {
  return nonFinite(value) ?? formatFixed(value, decimals);
}

export function formatExponentialSafe(value: number, decimals: number, upper: boolean): string {
  const special = nonFinite(value);
  if (special !== null) return upper ? special.toUpperCase() : special;
  return formatExponential(value, decimals, upper);
}
