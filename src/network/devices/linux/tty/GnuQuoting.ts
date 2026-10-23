const NAMED_ESCAPES: Readonly<Record<number, string>> = {
  7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r',
};

const SHELL_SPECIALS = new Set(' !"$&\'()*:;<=>?[\\^`|'.split(''));
const DOUBLE_QUOTE_SAFE = new Set(" %'+,-./:@]_".split(''));

function bytesOf(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function isPrintable(byte: number): boolean {
  return byte >= 0x20 && byte < 0x7f;
}

function octal(byte: number): string {
  return byte.toString(8).padStart(3, '0');
}

function isAlphanumeric(char: string): boolean {
  return /[A-Za-z0-9]/.test(char);
}

export function quote(text: string): string {
  let out = "'";
  for (const byte of bytesOf(text)) {
    if (byte === 0x27) out += "\\'";
    else if (byte === 0x5c) out += '\\\\';
    else if (isPrintable(byte)) out += String.fromCharCode(byte);
    else if (NAMED_ESCAPES[byte] !== undefined) out += `\\${NAMED_ESCAPES[byte]}`;
    else out += `\\${octal(byte)}`;
  }
  return `${out}'`;
}

function needsQuoting(bytes: readonly number[]): boolean {
  if (bytes.length === 0) return true;
  if (bytes.length === 1 && (bytes[0] === 0x7b || bytes[0] === 0x7d)) return true;
  return bytes.some((byte, index) => {
    if (!isPrintable(byte)) return true;
    const char = String.fromCharCode(byte);
    if (SHELL_SPECIALS.has(char)) return true;
    return index === 0 && (char === '#' || char === '~');
  });
}

function keepsDoubleQuotes(bytes: readonly number[]): boolean {
  if (!bytes.includes(0x27)) return false;
  return bytes.every((byte, index) => {
    if (!isPrintable(byte)) return false;
    const char = String.fromCharCode(byte);
    if (isAlphanumeric(char) || DOUBLE_QUOTE_SAFE.has(char)) return true;
    return index === 0 && (char === '#' || char === '~');
  });
}

export function quoteFilename(text: string): string {
  const bytes = bytesOf(text);
  if (!needsQuoting(bytes)) return text;
  if (keepsDoubleQuotes(bytes)) return `"${text}"`;
  let out = "'";
  let inQuote = true;
  let inEscape = false;
  for (const byte of bytes) {
    if (!isPrintable(byte)) {
      if (inQuote) {
        out += "'";
        inQuote = false;
      }
      if (!inEscape) {
        out += "$'";
        inEscape = true;
      }
      out += NAMED_ESCAPES[byte] !== undefined ? `\\${NAMED_ESCAPES[byte]}` : `\\${octal(byte)}`;
      continue;
    }
    if (inEscape) {
      out += "'";
      inEscape = false;
    }
    if (byte === 0x27) {
      out += inQuote ? "'\\''" : "\\''";
      inQuote = true;
      continue;
    }
    if (!inQuote) {
      out += "'";
      inQuote = true;
    }
    out += String.fromCharCode(byte);
  }
  if (inEscape) out += "'";
  if (inQuote) out += "'";
  return reopenedAfterQuote(bytes, out);
}

function reopenedAfterQuote(bytes: readonly number[], quoted: string): string {
  const firstQuote = bytes.indexOf(0x27);
  const endsInEscape = !isPrintable(bytes[bytes.length - 1]);
  if (!endsInEscape || firstQuote < 0 || firstQuote === bytes.length - 1) return quoted;
  if (!isPrintable(bytes[0])) return `'${quoted.slice(4)}`;
  return bytes[0] === 0x27 ? quoted : `''${quoted}`;
}
