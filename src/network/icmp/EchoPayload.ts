const TIMEVAL_BYTES = 16;
const WINDOWS_PATTERN = 'abcdefghijklmnopqrstuvwabcdefghi';

function littleEndian64(value: number): number[] {
  const bytes: number[] = [];
  let rest = BigInt(Math.max(0, Math.trunc(value)));
  for (let i = 0; i < 8; i++) {
    bytes.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return bytes;
}

export function iputilsEchoData(size: number, wallMicros: number): number[] {
  const data = Array.from({ length: size }, (_, i) => i & 0xff);
  if (size >= TIMEVAL_BYTES) {
    const seconds = Math.floor(wallMicros / 1_000_000);
    const microseconds = Math.floor(wallMicros) % 1_000_000;
    data.splice(0, TIMEVAL_BYTES, ...littleEndian64(seconds), ...littleEndian64(microseconds));
  }
  return data;
}

export function windowsEchoData(size: number): number[] {
  return Array.from({ length: size }, (_, i) => WINDOWS_PATTERN.charCodeAt(i % WINDOWS_PATTERN.length));
}
