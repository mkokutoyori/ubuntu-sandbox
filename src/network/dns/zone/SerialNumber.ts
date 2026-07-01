/**
 * RFC 1982 serial number arithmetic, used for SOA serials (RFC 1035 §3.3.13)
 * and IXFR/NOTIFY freshness comparisons. Serials are unsigned 32-bit and
 * compared circularly: a serial can wrap from 0xFFFFFFFF back to 0 and still
 * be considered "greater" than what preceded it.
 */

export class SerialNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerialNumberError';
  }
}

const SERIAL_BITS = 32;
const SERIAL_SPACE = 2 ** SERIAL_BITS;
const HALF_SERIAL_SPACE = 2 ** (SERIAL_BITS - 1);
const MAX_SERIAL = SERIAL_SPACE - 1;

function validateSerial(serial: number, fieldName: string): void {
  if (!Number.isInteger(serial) || serial < 0 || serial > MAX_SERIAL) {
    throw new SerialNumberError(
      `${fieldName} must be an unsigned 32-bit integer (0-${MAX_SERIAL}), got ${serial}`);
  }
}

/**
 * RFC 1982 §3.2: is `i1` "greater than" `i2` under circular serial space
 * arithmetic? Undefined (and rejected here) when the two serials are
 * exactly half the serial space apart.
 */
export function serialGreaterThan(i1: number, i2: number): boolean {
  validateSerial(i1, 'i1');
  validateSerial(i2, 'i2');

  const diff = ((i1 - i2) % SERIAL_SPACE + SERIAL_SPACE) % SERIAL_SPACE;

  if (diff === 0) return false;
  if (diff === HALF_SERIAL_SPACE) {
    throw new SerialNumberError(
      `serial comparison between ${i1} and ${i2} is undefined by RFC 1982 §3.2 ` +
      '(the two serials are exactly half the serial space apart)');
  }
  return diff < HALF_SERIAL_SPACE;
}

/**
 * RFC 1982 §3.1: add `n` to serial `s`, wrapping modulo 2^32. Only defined
 * for `0 <= n < 2^31` — larger increments have no well-defined result.
 */
export function serialAdd(s: number, n: number): number {
  validateSerial(s, 's');
  if (!Number.isInteger(n) || n < 0 || n >= HALF_SERIAL_SPACE) {
    throw new SerialNumberError(
      `addend must satisfy 0 <= n < ${HALF_SERIAL_SPACE} (RFC 1982 §3.1), got ${n}`);
  }
  return (s + n) % SERIAL_SPACE;
}
