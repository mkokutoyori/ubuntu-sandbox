export const HOST_NAME_MAX = 64;

const WHITESPACE = ' \t\n\r';
const SHELL_NEED_ESCAPE = '"\\`$';
const SHELL_NEED_QUOTES = `${SHELL_NEED_ESCAPE}*?['()<>|&;!`;
const ldh = (character: string): boolean => /^[A-Za-z0-9-]$/.test(character);

export function isHostnameValid(name: string, trailingDot = false): boolean {
  if (name === '') return false;
  let dot = true;
  let hyphen = true;
  let dots = 0;
  for (const character of name) {
    if (character === '.') {
      if (dot || hyphen) return false;
      dot = true;
      hyphen = false;
      dots++;
    } else if (character === '-') {
      if (dot) return false;
      dot = false;
      hyphen = true;
    } else {
      if (!ldh(character)) return false;
      dot = false;
      hyphen = false;
    }
  }
  if (dot && (dots < 2 || !trailingDot)) return false;
  if (hyphen) return false;
  return name.length <= HOST_NAME_MAX;
}

export function cleanupHostname(name: string): string {
  let out = '';
  let dot = true;
  let hyphen = true;
  for (const character of name) {
    if (out.length >= HOST_NAME_MAX) break;
    if (character === '.') {
      if (dot || hyphen) continue;
      out += '.';
      dot = true;
      hyphen = false;
    } else if (character === '-') {
      if (dot) continue;
      out += '-';
      dot = false;
      hyphen = true;
    } else if (ldh(character)) {
      out += character;
      dot = false;
      hyphen = false;
    }
  }
  return /[-.]$/.test(out) ? out.slice(0, -1) : out;
}

export function isLocalhostName(name: string): boolean {
  const lower = name.toLowerCase();
  return ['localhost', 'localhost.', 'localhost.localdomain', 'localhost.localdomain.'].includes(lower)
    || ['.localhost', '.localhost.', '.localhost.localdomain', '.localhost.localdomain.'].some((suffix) => lower.endsWith(suffix));
}

export function levenshtein(x: string, y: string): number {
  if (x === y) return 0;
  if (x === '') return y.length;
  if (y === '') return x.length;
  let t0 = new Array<number>(y.length + 1).fill(0);
  let t1 = Array.from({ length: y.length + 1 }, (_, index) => index);
  for (let i = 0; i < x.length; i++) {
    const t2 = new Array<number>(y.length + 1).fill(0);
    t2[0] = i + 1;
    for (let j = 0; j < y.length; j++) {
      t2[j + 1] = t1[j] + (x[i] !== y[j] ? 1 : 0);
      if (i > 0 && j > 0 && x[i - 1] === y[j] && x[i] === y[j - 1] && t2[j + 1] > t0[j - 1] + 1) t2[j + 1] = t0[j - 1] + 1;
      if (t2[j + 1] > t1[j + 1] + 1) t2[j + 1] = t1[j + 1] + 1;
      if (t2[j + 1] > t2[j] + 1) t2[j + 1] = t2[j] + 1;
    }
    t0 = t1;
    t1 = t2;
  }
  return t1[y.length];
}

const hasControlCharacter = (value: string): boolean => [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);

export function stringHasControlCharacters(value: string): boolean {
  return hasControlCharacter(value);
}

export function parseEnvFile(text: string): string[] {
  const entries: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[ \t]+/, '');
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match === null) continue;
    entries.push(`${match[1]}=${unquoteEnvValue(match[2])}`);
  }
  return entries;
}

function unquoteEnvValue(raw: string): string {
  let out = '';
  let index = 0;
  while (index < raw.length) {
    const character = raw[index];
    if (character === '"') {
      index++;
      while (index < raw.length && raw[index] !== '"') {
        if (raw[index] === '\\' && index + 1 < raw.length) index++;
        out += raw[index++];
      }
      index++;
    } else if (character === "'") {
      index++;
      while (index < raw.length && raw[index] !== "'") out += raw[index++];
      index++;
    } else if (character === '\\' && index + 1 < raw.length) {
      out += raw[index + 1];
      index += 2;
    } else {
      out += character;
      index++;
    }
  }
  return out.replace(/[ \t\r]+$/, '');
}

export function assignEnv(entries: readonly string[], key: string, value: string | null): string[] {
  const prefix = `${key}=`;
  if (value === null) return entries.filter((entry) => !entry.startsWith(prefix));
  const replacement = `${prefix}${value}`;
  if (!entries.some((entry) => entry.startsWith(prefix))) return [...entries, replacement];
  let placed = false;
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) out.push(entry);
    else if (!placed) {
      out.push(replacement);
      placed = true;
    }
  }
  return out;
}

export function serializeEnvFile(entries: readonly string[]): string {
  return entries.map((entry) => {
    const equals = entry.indexOf('=');
    if (equals < 0) return `${entry}\n`;
    const key = entry.slice(0, equals + 1);
    const value = entry.slice(equals + 1);
    if (!hasControlCharacter(value) && ![...value].some((character) => (WHITESPACE + SHELL_NEED_QUOTES).includes(character))) {
      return `${key}${value}\n`;
    }
    const escaped = [...value].map((character) => (SHELL_NEED_ESCAPE.includes(character) ? `\\${character}` : character)).join('');
    return `${key}"${escaped}"\n`;
  }).join('');
}
