const BYTES_PER_LINE = 16;

function two(value: number): string {
  return value.toString(16).padStart(2, '0');
}

export function hexPrintLines(bytes: readonly number[], ident: string): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += BYTES_PER_LINE) {
    text += `${ident}0x${at.toString(16).padStart(4, '0')}: `;
    const end = Math.min(at + BYTES_PER_LINE, bytes.length);
    for (let i = at; i < end; i += 2) text += end - i === 1 ? ` ${two(bytes[i])}` : ` ${two(bytes[i])}${two(bytes[i + 1])}`;
  }
  return text;
}

export function hexAndAsciiLines(bytes: readonly number[], ident: string): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += BYTES_PER_LINE) {
    const chunk = bytes.slice(at, at + BYTES_PER_LINE);
    let hex = '';
    for (let i = 0; i < chunk.length; i += 2) hex += chunk.length - i === 1 ? ` ${two(chunk[i])}` : ` ${two(chunk[i])}${two(chunk[i + 1])}`;
    const ascii = chunk.map(b => (b >= 0x21 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
    text += `${ident}0x${at.toString(16).padStart(4, '0')}: ${hex.padEnd(40)}  ${ascii}`;
  }
  return text;
}
