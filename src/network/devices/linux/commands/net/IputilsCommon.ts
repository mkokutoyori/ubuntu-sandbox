export const IPUTILS_VERSION_LINE = 'from iputils 20221126';
export const INT_MAX = 2147483647;
export const LONG_MAX = '9223372036854775807';

function strtolPrefix(text: string): { value: bigint; rest: string } | null {
  const m = /^\s*([+-]?\d+)/.exec(text);
  if (m === null) return null;
  return { value: BigInt(m[1]), rest: text.slice(m[0].length) };
}

export function strtolOrErr(
  cmd: string, text: string, message: string, min: bigint, max: bigint,
): { value: number } | { error: string } {
  const parsed = text === '' ? null : strtolPrefix(text);
  if (parsed === null || parsed.rest !== '') return { error: `${cmd}: ${message}: '${text}'` };
  if (parsed.value > BigInt(LONG_MAX) || parsed.value < -BigInt(LONG_MAX) - 1n) {
    return { error: `${cmd}: ${message}: '${text}': Numerical result out of range` };
  }
  if (parsed.value < min || parsed.value > max) {
    return { error: `${cmd}: ${message}: '${text}': out of range: ${min} <= value <= ${max}` };
  }
  return { value: Number(parsed.value) };
}
