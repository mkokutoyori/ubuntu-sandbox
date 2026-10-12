import { TTY_NAMED_KEYS } from './AuditTtyKeys';
import { unescapeHex } from './AuditCString';

export type EscapeMode = 'raw' | 'tty' | 'shell' | 'shell_quote';

const MAX_AUDIT_MESSAGE_LENGTH = 8970;
const SH_SET = '"\'`$\\!()| ';
const QUOTE_SET = '"\'`$\\!()| ;#&*?[]<>{}';

function octal(code: number): string {
  return `\\${((code & 0o300) >> 6)}${((code & 0o070) >> 3)}${code & 0o007}`;
}

function escapeWith(text: string, mode: EscapeMode): string | null {
  const bytes = new TextEncoder().encode(text);
  let needs = false;
  let out = '';
  const decoder = new TextDecoder();
  for (const b of bytes) {
    if (b < 32) {
      needs = true;
      out += octal(b);
    } else if ((mode === 'shell' && SH_SET.includes(String.fromCharCode(b)))
      || (mode === 'shell_quote' && QUOTE_SET.includes(String.fromCharCode(b)))) {
      needs = true;
      out += `\\${String.fromCharCode(b)}`;
    } else out += b < 128 ? String.fromCharCode(b) : '';
  }
  if (!needs) return null;
  if (bytes.some((b) => b >= 128)) {
    let rebuilt = '';
    const chunk: number[] = [];
    const flush = (): void => {
      if (chunk.length) { rebuilt += decoder.decode(Uint8Array.from(chunk)); chunk.length = 0; }
    };
    for (const b of bytes) {
      if (b >= 128) chunk.push(b);
      else {
        flush();
        if (b < 32) rebuilt += octal(b);
        else if ((mode === 'shell' && SH_SET.includes(String.fromCharCode(b))) || (mode === 'shell_quote' && QUOTE_SET.includes(String.fromCharCode(b)))) rebuilt += `\\${String.fromCharCode(b)}`;
        else rebuilt += String.fromCharCode(b);
      }
    }
    flush();
    return rebuilt;
  }
  return out;
}

export function safePrintString(text: string | null, ret: boolean, mode: EscapeMode): string {
  if (text === null) return '(null)';
  const clipped = text.length > MAX_AUDIT_MESSAGE_LENGTH ? text.slice(0, MAX_AUDIT_MESSAGE_LENGTH) : text;
  const escaped = mode === 'raw' ? null : escapeWith(clipped, mode);
  if (escaped !== null) return ret ? `${escaped}\n` : escaped;
  return ret ? `${clipped}\n` : clipped;
}

function ttyPrintableChar(c: number): string {
  if (c < 0x20 || c > 0x7e) return octal(c);
  const ch = String.fromCharCode(c);
  return ch === '\\' || ch === '"' ? `\\${ch}` : ch;
}

function findNamedKey(bytes: number[], pos: number): { name: string; length: number } | null {
  const first = bytes[pos];
  if (first >= 0x20 && (first < 0x7f || first >= 0xa0)) return null;
  for (const [seq, name] of TTY_NAMED_KEYS) {
    if (seq.length <= bytes.length - pos && seq.every((b, i) => bytes[pos + i] === b)) return { name, length: seq.length };
  }
  return null;
}

export function ttyDataText(val: string): string {
  if (!/^[0-9a-fA-F]*$/.test(val)) return val;
  const decoded = unescapeHex(val, 0);
  if (decoded === null) return `conversion error(${val})`;
  const raw: number[] = [];
  for (let i = 0; i + 1 < val.length + 1; i += 2) {
    const pair = val.slice(i, i + 2);
    if (pair === '') break;
    raw.push(parseInt(pair.length === 1 ? pair + '0' : pair, 16));
  }
  const data = raw.slice(0, Math.floor(val.length / 2));
  let out = '';
  let needComma = false;
  let inPrintable = false;
  let pos = 0;
  while (pos < data.length) {
    const named = findNamedKey(data, pos);
    if (named) {
      if (inPrintable) { out += '"'; inPrintable = false; }
      if (needComma) out += ',';
      out += `<${named.name}>`;
      pos += named.length;
    } else {
      if (!inPrintable) {
        if (needComma) out += ',';
        out += '"';
        inPrintable = true;
      }
      out += ttyPrintableChar(data[pos]);
      pos++;
    }
    needComma = true;
  }
  if (inPrintable) out += '"';
  return out;
}
