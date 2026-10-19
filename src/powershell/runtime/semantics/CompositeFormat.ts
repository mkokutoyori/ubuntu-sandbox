import type { PSValue } from '../PSEnvironment';
import { psValueToString } from '../PSExpansion';

export function formatString(fmt: string, args: PSValue[]): string {
  return fmt.replace(/\{(\d+)(?:,(-?\d+))?(?::([^}]+))?\}/g,
    (_m: string, idxStr: string, padStr: string | undefined, spec: string | undefined): string => {
      const idx = Number.parseInt(idxStr, 10);
      const value = args[idx];
      let body = spec !== undefined ? applyFormatSpec(value, spec) : psValueToString(value);
      if (padStr !== undefined) {
        const width = Number.parseInt(padStr, 10);
        const pad = Math.abs(width) - body.length;
        if (pad > 0) {
          body = width < 0 ? body + ' '.repeat(pad) : ' '.repeat(pad) + body;
        }
      }
      return body;
    });
}

function applyFormatSpec(value: PSValue, spec: string): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n) && /[NDFXEPC]/i.test(spec[0] ?? '')) return psValueToString(value);
  const code = spec[0].toUpperCase();
  const digits = spec.length > 1 ? Number.parseInt(spec.slice(1), 10) : NaN;
  switch (code) {
    case 'N': {
      const p = Number.isFinite(digits) ? digits : 2;
      const fixed = n.toFixed(p);
      const [intPart, decPart] = fixed.split('.');
      const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return decPart !== undefined ? `${withCommas}.${decPart}` : withCommas;
    }
    case 'D': return Number.isFinite(digits) ? String(Math.trunc(n)).padStart(digits, '0') : String(Math.trunc(n));
    case 'F': return n.toFixed(Number.isFinite(digits) ? digits : 2);
    case 'X': {
      const hex = Math.trunc(n).toString(16);
      return Number.isFinite(digits) ? hex.padStart(digits, '0') : hex;
    }
    case 'E': return n.toExponential(Number.isFinite(digits) ? digits : 6);
    case 'P': {
      const p = Number.isFinite(digits) ? digits : 2;
      return (n * 100).toFixed(p) + '%';
    }
    case 'C': return '$' + n.toFixed(Number.isFinite(digits) ? digits : 2);
    default: return psValueToString(value);
  }
}
