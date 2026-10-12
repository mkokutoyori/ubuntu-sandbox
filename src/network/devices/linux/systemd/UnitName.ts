const UNIT_TYPES = ['service', 'socket', 'target', 'device', 'mount', 'automount', 'swap', 'timer', 'path', 'slice', 'scope'];
const UNIT_NAME_MAX = 256;
const VALID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:-_.\\';
const VALID_CHARS_WITH_AT = `@${VALID_CHARS}`;
const VALID_CHARS_GLOB = `${VALID_CHARS_WITH_AT}[]!-*?`;
const GLOB_CHARS = '*?[';

export const isGlob = (text: string): boolean => [...GLOB_CHARS].some(ch => text.includes(ch));

export interface UnitNameKinds {
  plain?: boolean;
  instance?: boolean;
  template?: boolean;
}

export function unitNameIsValid(name: string, kinds: UnitNameKinds = { plain: true, instance: true, template: true }): boolean {
  if (name === '' || name.length >= UNIT_NAME_MAX) return false;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  if (!UNIT_TYPES.includes(name.slice(dot + 1))) return false;
  let at = -1;
  for (let i = 0; i < dot; i++) {
    if (name[i] === '@' && at < 0) at = i;
    if (!VALID_CHARS_WITH_AT.includes(name[i])) return false;
  }
  if (at === 0) return false;
  if (kinds.plain && at < 0) return true;
  if (kinds.instance && at >= 0 && dot > at + 1) return true;
  if (kinds.template && at >= 0 && dot === at + 1) return true;
  return false;
}

export const unitNameToType = (name: string): string | null => (unitNameIsValid(name) ? name.slice(name.lastIndexOf('.') + 1) : null);

const hex = (value: number): string => '0123456789abcdef'[value & 15];
const escapeChar = (ch: string): string => `\\x${hex(ch.charCodeAt(0) >> 4)}${hex(ch.charCodeAt(0))}`;

function escapeMangle(from: string, allowGlobs: boolean): { value: string; mangled: boolean } {
  const valid = allowGlobs ? VALID_CHARS_GLOB : VALID_CHARS_WITH_AT;
  let value = '';
  let mangled = false;
  for (const ch of from) {
    if (ch === '/') {
      value += '-';
      mangled = true;
    } else if (!valid.includes(ch)) {
      value += escapeChar(ch);
      mangled = true;
    } else value += ch;
  }
  return { value, mangled };
}

export function unitNameEscape(from: string): string {
  let value = '';
  for (let i = 0; i < from.length; i++) {
    const ch = from[i];
    if (ch === '/') value += '-';
    else if (ch === '-' || ch === '\\' || (i === 0 && ch === '.') || !VALID_CHARS.includes(ch)) value += escapeChar(ch);
    else value += ch;
  }
  return value;
}

export interface MangleResult {
  name: string | null;
  notices: string[];
}

export function unitNameMangle(name: string, options: { glob: boolean; warn: boolean }): MangleResult {
  const notices: string[] = [];
  if (name === '') return { name: null, notices };
  if (unitNameIsValid(name)) return { name, notices };
  let suggestEscape = true;
  const allCharsGlob = [...name].every(ch => VALID_CHARS_GLOB.includes(ch));
  if (isGlob(name) && allCharsGlob) {
    if (options.glob) return { name, notices };
    if (options.warn) notices.push('Glob pattern passed, but globs are not supported for this.');
    suggestEscape = false;
  }
  if (name.startsWith('/')) {
    const simplified = `/${name.split('/').filter(part => part !== '').join('/')}`;
    const device = simplified.startsWith('/dev/') || simplified.startsWith('/sys/');
    const body = simplified === '/' ? '-' : unitNameEscape(simplified.slice(1).replace(/\/+$/, ''));
    const candidate = `${body}${device ? '.device' : '.mount'}`;
    if (unitNameIsValid(candidate) || candidate.length < UNIT_NAME_MAX) return { name: candidate, notices };
  }
  const escaped = escapeMangle(name, options.glob);
  let value = escaped.value;
  if (escaped.mangled && options.warn) notices.push(`Invalid unit name "${name}" escaped as "${value}"${suggestEscape ? ' (maybe you should use systemd-escape?)' : ''}.`);
  if ((!options.glob || !isGlob(value)) && unitNameToType(value) === null) value += '.service';
  if (!options.glob && !unitNameIsValid(value)) return { name: null, notices };
  return { name: value, notices };
}
