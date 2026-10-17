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

const TOS_MAX = 255;
const FLOW_LABEL_MASK = 0xfffffn;

function cStrtol(text: string, base: 10 | 16): { value: bigint; rest: string } {
  const digits = base === 16 ? '[0-9a-fA-F]' : '[0-9]';
  const m = new RegExp(`^\\s*([+-]?)(${digits}+)`).exec(text);
  if (m === null) return { value: 0n, rest: text };
  const magnitude = BigInt(base === 16 ? `0x${m[2]}` : m[2]);
  return { value: m[1] === '-' ? -magnitude : magnitude, rest: text.slice(m[0].length) };
}

function hasHexPrefix(text: string): boolean {
  return text[0] === '0' && (text[1] === 'x' || text[1] === 'X');
}

export function parseTosOrErr(cmd: string, text: string): { value: number } | { error: string } {
  const { value, rest } = hasHexPrefix(text) ? cStrtol(text.slice(2), 16) : cStrtol(text, 10);
  if (rest !== '') return { error: `${cmd}: bad TOS value: ${text}` };
  const tos = Number(BigInt.asIntN(32, value));
  if (tos > TOS_MAX) return { error: `${cmd}: the decimal value of TOS bits must be in range 0-255: ${tos}` };
  return { value: tos & TOS_MAX };
}

export function parseFlowOrErr(cmd: string, text: string): { value: number } | { error: string } {
  const { value, rest } = hasHexPrefix(text) ? cStrtol(text.slice(2), 16) : cStrtol(text, 10);
  if (rest !== '') return { error: `${cmd}: bad value for flowinfo: ${text}` };
  const flow = BigInt.asUintN(64, BigInt.asIntN(32, BigInt.asUintN(64, value)));
  if ((flow & ~FLOW_LABEL_MASK) !== 0n) return { error: `${cmd}: flow value is greater than 20 bits: ${text}` };
  return { value: Number(flow) };
}
