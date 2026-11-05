import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { actorOf, type ShellContext } from '../LinuxFileCommands';
import { Streams, docsResult, quoteLocale, quotef, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'portability', letter: 'W', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const POSIX_PATH_MAX = 255;
const POSIX_NAME_MAX = 14;
const SYSTEM_PATH_MAX = 4096;
const SYSTEM_NAME_MAX = 255;

const inUtf8Locale = (): boolean => quoteLocale('a') !== "'a'";

function quoteName(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (inUtf8Locale() || bytes.every((byte) => byte >= 32 && byte < 127)) return `'${text.replace(/'/g, `'\\''`)}'`;
  let out = '';
  let run = '';
  let escaped = '';
  let inEscaped = false;
  for (const byte of bytes) {
    if (byte >= 32 && byte < 127) {
      if (inEscaped) { out += `$'${escaped}'`; escaped = ''; inEscaped = false; }
      run += String.fromCharCode(byte);
    } else {
      if (!inEscaped) { out += `'${run}'`; run = ''; inEscaped = true; }
      escaped += `\\${byte.toString(8).padStart(3, '0')}`;
    }
  }
  return inEscaped ? `${out}$'${escaped}'` : `${out}'${run}'`;
}

function quoteCharacter(text: string): string {
  if (inUtf8Locale()) return quoteLocale(text);
  const byte = Buffer.from(text, 'utf8')[0];
  return byte >= 32 && byte < 127 ? `'${text}'` : `'\\${byte.toString(8).padStart(3, '0')}'`;
}

export function runPathchk(ctx: ShellContext, args: readonly string[]): CoreutilsRun {
  let basic = false;
  let extra = false;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'pP', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('pathchk', getoptDiagnostic('pathchk', item));
    switch (item.letter) {
      case 'H': return docsResult('pathchk', 'help');
      case 'V': return docsResult('pathchk', 'version');
      case 'p': basic = true; break;
      case 'P': extra = true; break;
      case 'W': basic = true; extra = true; break;
      default: break;
    }
  }
  if (operands.length === 0) return usageFailure('pathchk', 'pathchk: missing operand');
  const streams = new Streams();
  const actor = actorOf(ctx);
  const problem = (file: string): string | null => {
    if (basic || extra) {
      if (file === '') return 'pathchk: empty file name';
    } else if (file === '') {
      return `pathchk: ${quotef(file)}: No such file or directory`;
    }
    const pathMax = basic ? POSIX_PATH_MAX : SYSTEM_PATH_MAX;
    const nameMax = basic ? POSIX_NAME_MAX : SYSTEM_NAME_MAX;
    const length = Buffer.byteLength(file, 'utf8');
    if (length > pathMax) return `pathchk: limit ${pathMax} exceeded by length ${length} of file name ${quoteName(file)}`;
    let prefix = file.startsWith('/') ? '/' : '';
    let walking = true;
    const parts = file.split('/').filter((part) => part !== '');
    for (const [position, component] of parts.entries()) {
      const last = position === parts.length - 1;
      if (basic) {
        for (const character of component) {
          if (!/^[A-Za-z0-9._-]$/.test(character)) return `pathchk: non-portable character ${quoteCharacter(character)} in file name ${quoteName(file)}`;
        }
      } else {
        const here = `${prefix}${component}`;
        const node = walking ? ctx.vfs.path(here, prefix === '' ? ctx.cwd : '/', actor).lstatNode() : null;
        if (walking && Buffer.byteLength(component, 'utf8') > nameMax) return `pathchk: ${quotef(file)}: File name too long`;
        if (node === null) walking = false;
        else if (node.type !== 'directory' && node.type !== 'symlink' && !last) return `pathchk: ${quotef(file)}: Not a directory`;
      }
      const componentLength = Buffer.byteLength(component, 'utf8');
      if (componentLength > nameMax) return `pathchk: limit ${nameMax} exceeded by length ${componentLength} of file name component ${quoteLocale(component)}`;
      if (extra && component.startsWith('-')) return `pathchk: leading '-' in a component of file name ${quoteName(file)}`;
      prefix = prefix === '' ? `${component}/` : `${prefix}${component}/`;
    }
    return null;
  };
  for (const file of operands) {
    const message = problem(file);
    if (message === null) continue;
    streams.diagnostic(message);
    streams.exitCode = 1;
  }
  return streams.result();
}

export function runHostid(args: readonly string[], addressV4: string): CoreutilsRun {
  const operands: string[] = [];
  for (const item of shortOptions(args, '', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('hostid', getoptDiagnostic('hostid', item));
    return docsResult('hostid', item.letter === 'H' ? 'help' : 'version');
  }
  if (operands.length > 0) return usageFailure('hostid', `hostid: extra operand ${quoteLocale(operands[0])}`);
  const octets = addressV4.split('.').map(Number);
  const network = ((octets[3] << 24) | (octets[2] << 16) | (octets[1] << 8) | octets[0]) >>> 0;
  const swapped = (((network << 16) | (network >>> 16)) >>> 0).toString(16).padStart(8, '0');
  const streams = new Streams();
  streams.stdout(`${swapped}\n`);
  return streams.result();
}
