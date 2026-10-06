function greatestCommonDivisor(left: number, right: number): number {
  return right === 0 ? left : greatestCommonDivisor(right, left % right);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index--) {
    out[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

export function nFold(input: Uint8Array, outputBytes: number): Uint8Array {
  if (input.length === 0 || outputBytes <= 0) throw new Error('nFold: input and output lengths must be positive');
  const inputBits = BigInt(input.length * 8);
  const outputBits = BigInt(outputBytes * 8);
  const inputMask = (1n << inputBits) - 1n;
  const outputMask = (1n << outputBits) - 1n;
  const commonBytes = (input.length * outputBytes) / greatestCommonDivisor(input.length, outputBytes);
  const base = bytesToBigInt(input);

  let stream = 0n;
  for (let copy = 0; copy < commonBytes / input.length; copy++) {
    const shift = BigInt((13 * copy) % (input.length * 8));
    const rotated = shift === 0n ? base : ((base >> shift) | (base << (inputBits - shift))) & inputMask;
    stream = (stream << inputBits) | rotated;
  }

  let total = 0n;
  for (let chunk = 0; chunk < commonBytes / outputBytes; chunk++) {
    total += (stream >> (BigInt(chunk) * outputBits)) & outputMask;
  }
  while (total >> outputBits > 0n) total = (total & outputMask) + (total >> outputBits);
  return bigIntToBytes(total, outputBytes);
}
