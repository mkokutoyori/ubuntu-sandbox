export type EscapeDialect = 'ansi-c' | 'echo' | 'printf-b' | 'printf-format';

export interface DecodedEscapes {
  readonly text: string;
  readonly stopped: boolean;
}

const SIMPLE: Readonly<Record<string, string>> = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\',
};

function controlCharacter(character: string): string {
  if (character === '?') return '\x7f';
  return String.fromCharCode(character.toUpperCase().charCodeAt(0) & 0x1f);
}

function takeDigits(source: string, from: number, maximum: number, pattern: RegExp): string {
  let digits = '';
  while (digits.length < maximum && from + digits.length < source.length && pattern.test(source[from + digits.length])) {
    digits += source[from + digits.length];
  }
  return digits;
}

export function decodeBackslashEscapes(source: string, dialect: EscapeDialect): DecodedEscapes {
  let text = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character !== '\\' || index + 1 >= source.length) {
      text += character;
      index++;
      continue;
    }
    const code = source[index + 1];
    index += 2;
    if (code in SIMPLE && !(dialect === 'printf-format' && code === 'E')) {
      text += SIMPLE[code];
      continue;
    }
    if (code === "'" && dialect === 'ansi-c') { text += "'"; continue; }
    if (code === '"' && dialect === 'ansi-c') { text += '"'; continue; }
    if (code === '?' && dialect === 'ansi-c') { text += '?'; continue; }
    if (code === 'c') {
      if (dialect === 'ansi-c' && index < source.length) {
        text += controlCharacter(source[index]);
        index++;
        continue;
      }
      if (dialect !== 'ansi-c') return { text, stopped: true };
    }
    if (code === 'x') {
      const digits = takeDigits(source, index, 2, /[0-9a-fA-F]/);
      if (digits !== '') {
        text += String.fromCharCode(parseInt(digits, 16));
        index += digits.length;
        continue;
      }
    }
    if ((code === 'u' || code === 'U') && dialect !== 'echo') {
      const digits = takeDigits(source, index, code === 'u' ? 4 : 8, /[0-9a-fA-F]/);
      if (digits !== '') {
        text += String.fromCodePoint(parseInt(digits, 16));
        index += digits.length;
        continue;
      }
    }
    if (/[0-7]/.test(code) && !(code === '0' && (dialect === 'echo' || dialect === 'printf-b'))) {
      const digits = code + takeDigits(source, index, 2, /[0-7]/);
      text += String.fromCharCode(parseInt(digits, 8) & 0xff);
      index += digits.length - 1;
      continue;
    }
    if (code === '0') {
      const digits = takeDigits(source, index, 3, /[0-7]/);
      text += String.fromCharCode(parseInt(digits === '' ? '0' : digits, 8) & 0xff);
      index += digits.length;
      continue;
    }
    text += `\\${code}`;
  }
  return { text, stopped: false };
}
