const MODE_NAMES: readonly string[] = [
  'unspecified', 'symmetric active', 'symmetric passive', 'Client', 'Server', 'Broadcast', 'Control Message', 'Reserved',
];
const LEAP_NAMES: readonly string[] = ['', '+1s', '-1s', 'clock unsynchronized'];
const UNIX_EPOCH_IN_NTP_SECONDS = 2208988800;
const NTP_HEADER = 48;
const CONTROL_HEADER = 12;

function u16(bytes: readonly number[], at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function u32(bytes: readonly number[], at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function timestampOf(bytes: readonly number[], at: number): bigint {
  return (BigInt(u32(bytes, at)) << 32n) | BigInt(u32(bytes, at + 4));
}

function nanoseconds(fraction: bigint): string {
  return String((fraction * 1_000_000_000n) >> 32n).padStart(9, '0');
}

function isoOf(seconds: bigint): string {
  const unix = Number(seconds) - UNIX_EPOCH_IN_NTP_SECONDS;
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function timeText(timestamp: bigint): string {
  if (timestamp === 0n) return '0.000000000';
  const seconds = timestamp >> 32n;
  return `${seconds}.${nanoseconds(timestamp & 0xffffffffn)} (${isoOf(seconds)})`;
}

function deltaText(origin: bigint, later: bigint): string {
  if (origin === 0n) return timeText(later);
  const difference = later - origin;
  const magnitude = difference < 0n ? -difference : difference;
  return `${difference > 0n ? '+' : '-'}${magnitude >> 32n}.${nanoseconds(magnitude & 0xffffffffn)}`;
}

function shortFormat(value: number): string {
  const fraction = Math.floor(((value & 0xffff) * 1_000_000) / 65536);
  return `${value >>> 16}.${String(fraction).padStart(6, '0')}`;
}

function visual(byte: number): string {
  let out = '';
  let c = byte;
  if (c >= 128) { out += 'M-'; c &= 0x7f; }
  if (c < 32) return `${out}^${String.fromCharCode(c + 64)}`;
  if (c === 127) return `${out}^?`;
  return out + String.fromCharCode(c);
}

function referenceText(bytes: readonly number[], stratum: number): string {
  if (stratum === 0) return '(unspec)';
  if (stratum === 1) return bytes.slice(12, 16).map(visual).join('');
  return `0x${u32(bytes, 12).toString(16).padStart(8, '0')}`;
}

function stratumText(stratum: number): string {
  if (stratum === 0) return 'unspecified';
  if (stratum === 1) return 'primary reference';
  return stratum < 16 ? 'secondary reference' : 'reserved';
}

function pollText(poll: number): string {
  const signed = poll > 127 ? poll - 256 : poll;
  if (signed >= 0 && signed <= 31) return `${signed} (${2 ** signed}s)`;
  if (signed < 0 && signed >= -31) return `${signed} (1/${2 ** -signed}s)`;
  return String(signed);
}

function leapText(first: number): string {
  const value = first & 0xc0;
  return `Leap indicator: ${LEAP_NAMES[value >> 6]} (${value})`;
}

function controlLines(bytes: readonly number[]): string[] {
  const second = bytes[1];
  const status = u16(bytes, 4);
  const count = u16(bytes, 10);
  const lines = [
    `\t${leapText(bytes[0])}, ${second & 0x80 ? 'Response' : 'Request'}, ${second & 0x40 ? 'Error' : 'OK'}, ${second & 0x20 ? 'More' : 'Last'}, OpCode=${second & 0x1f}`,
    `\tSequence=${u16(bytes, 2)}, Status=${status === 0 ? '0' : `0x${status.toString(16)}`}, Assoc.=${u16(bytes, 6)}, Offset=${u16(bytes, 8)}, Count=${count}`,
  ];
  if (count > 0) lines.push('\tTO-BE-DONE: data not interpreted');
  return lines;
}

function trailerLines(bytes: readonly number[]): string[] {
  const remaining = bytes.length - NTP_HEADER;
  if (remaining === 4) return [`\tKey id: ${u32(bytes, NTP_HEADER)}`];
  if (remaining === 20 || remaining === 24) {
    const digest = bytes.slice(NTP_HEADER + 4).map((b) => b.toString(16).padStart(2, '0')).join('');
    return [`\tKey id: ${u32(bytes, NTP_HEADER)}`, `\tAuthentication: ${digest}`];
  }
  return remaining > 0 ? [`\t(${remaining} more bytes after the header)`] : [];
}

export function ntpText(bytes: readonly number[], verbose: number, checksumToken: string): string {
  const first = bytes[0] ?? 0;
  const mode = first & 0x7;
  const head = `NTPv${(first >> 3) & 0x7}, ${MODE_NAMES[mode]}, length ${bytes.length}`;
  if (verbose === 0) return head;
  const prefix = verbose >= 2 ? checksumToken : '';
  if (mode === 7) return `${prefix}${head}\n\t${leapText(first)}`;
  if (mode === 6) {
    if (bytes.length < CONTROL_HEADER) return `${prefix}${head}\n\t${leapText(first)} (invalid)`;
    return [`${prefix}${head}`, ...controlLines(bytes)].join('\n');
  }
  if (bytes.length < NTP_HEADER) return `${prefix}${head}\n\t${leapText(first)} (invalid)`;
  const stratum = bytes[1];
  const origin = timestampOf(bytes, 24);
  const receive = timestampOf(bytes, 32);
  const transmit = timestampOf(bytes, 40);
  return [
    `${prefix}${head}`,
    `\t${leapText(first)}, Stratum ${stratum} (${stratumText(stratum)}), poll ${pollText(bytes[2])}, precision ${bytes[3] > 127 ? bytes[3] - 256 : bytes[3]}`,
    `\tRoot Delay: ${shortFormat(u32(bytes, 4))}, Root dispersion: ${shortFormat(u32(bytes, 8))}, Reference-ID: ${referenceText(bytes, stratum)}`,
    `\t  Reference Timestamp:  ${timeText(timestampOf(bytes, 16))}`,
    `\t  Originator Timestamp: ${timeText(origin)}`,
    `\t  Receive Timestamp:    ${timeText(receive)}`,
    `\t  Transmit Timestamp:   ${timeText(transmit)}`,
    `\t    Originator - Receive Timestamp:  ${deltaText(origin, receive)}`,
    `\t    Originator - Transmit Timestamp: ${deltaText(origin, transmit)}`,
    ...trailerLines(bytes),
  ].join('\n');
}
