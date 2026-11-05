import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandExecutor } from '../../LinuxCommandExecutor';
import { getoptDiagnostic, shortOptions, type LongOption } from '../Getopt';

const FALLOCATE_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-l', aliases: ['--length'], dest: 'length', takesArg: true, argName: 'LEN', description: 'Specifies the length of the range, in bytes' },
  { flag: '-o', aliases: ['--offset'], dest: 'offset', takesArg: true, argName: 'OFF', description: 'Specifies the beginning offset of the range, in bytes' },
];

const OPTSTRING = 'cdil:no:pvxzhV';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'collapse-range', letter: 'c', takesArgument: false },
  { name: 'dig-holes', letter: 'd', takesArgument: false },
  { name: 'insert-range', letter: 'i', takesArgument: false },
  { name: 'length', letter: 'l', takesArgument: true },
  { name: 'keep-size', letter: 'n', takesArgument: false },
  { name: 'offset', letter: 'o', takesArgument: true },
  { name: 'punch-hole', letter: 'p', takesArgument: false },
  { name: 'zero-range', letter: 'z', takesArgument: false },
  { name: 'posix', letter: 'x', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const HELP = `
Usage:
 fallocate [options] <filename>

Preallocate space to, or deallocate space from a file.

Options:
 -c, --collapse-range remove a range from the file
 -d, --dig-holes      detect zeroes and replace with holes
 -i, --insert-range   insert a hole at range, shifting existing data
 -l, --length <num>   length for range operations, in bytes
 -n, --keep-size      maintain the apparent size of the file
 -o, --offset <num>   offset for range operations, in bytes
 -p, --punch-hole     replace a range with a hole (implies -n)
 -z, --zero-range     zero and ensure allocation of a range
 -x, --posix          use posix_fallocate(3) instead of fallocate(2)
 -v, --verbose        verbose mode

 -h, --help           display this help
 -V, --version        display version

Arguments:
 <num> arguments may be followed by the suffixes for
   GiB, TiB, PiB, EiB, ZiB, and YiB (the "iB" is optional)

For more details see fallocate(1).`;

const BLOCK = 4096;
const UNITS = 'KMGTPEZY';
const HUMAN_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];

export function parseFallocateSize(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([KMGTPEZY])?(iB|B)?$/i.exec(text.trim());
  if (!match) return null;
  const unit = match[2] === undefined ? -1 : UNITS.indexOf(match[2].toUpperCase());
  if (unit < 0 && match[3] !== undefined && match[3].toLowerCase() !== 'b') return null;
  const base = match[3]?.toLowerCase() === 'b' && unit >= 0 ? 1000 : 1024;
  const value = Math.round(parseFloat(match[1]) * base ** (unit + 1));
  return Number.isSafeInteger(value) ? value : null;
}

export function humanSizeForFallocate(bytes: number): string {
  let unit = 0;
  while (unit < HUMAN_UNITS.length - 1 && bytes >= 1024 ** (unit + 1)) unit++;
  const value = bytes / 1024 ** unit;
  const text = unit === 0 ? String(value) : (Math.round(value * 10) / 10).toString();
  return `${text} ${HUMAN_UNITS[unit]}`;
}

type Outcome = { output: string; exitCode: number };

const failure = (message: string): Outcome => ({ output: `fallocate: ${message}`, exitCode: 1 });

export function runFallocate(exec: LinuxCommandExecutor, args: string[]): Outcome {
  let lengthText: string | undefined;
  let offsetText: string | undefined;
  const flags = new Set<string>();
  const files: string[] = [];
  for (const item of shortOptions(args, OPTSTRING, LONG_OPTIONS)) {
    if (item.kind === 'operand') { files.push(item.value); continue; }
    if (item.kind !== 'option') {
      return { output: `${getoptDiagnostic('fallocate', item)}\nTry 'fallocate --help' for more information.`, exitCode: 1 };
    }
    switch (item.letter) {
      case 'h': return { output: HELP, exitCode: 0 };
      case 'V': return { output: 'fallocate from util-linux 2.37.2', exitCode: 0 };
      case 'l': lengthText = item.argument ?? ''; break;
      case 'o': offsetText = item.argument ?? ''; break;
      default: flags.add(item.letter);
    }
  }

  if (files.length === 0) return failure('no filename specified');
  if (files.length > 1) return failure('unexpected number of arguments');

  let length: number | undefined;
  if (lengthText !== undefined) {
    const value = parseFallocateSize(lengthText);
    if (value === null || value <= 0) return failure('invalid length value specified');
    length = value;
  }
  let offset = 0;
  if (offsetText !== undefined) {
    const value = parseFallocateSize(offsetText);
    if (value === null) return failure('invalid offset value specified');
    offset = value;
  }

  const rangeModes = ['c', 'd', 'p', 'z'].filter((f) => flags.has(f));
  if (rangeModes.length > 1) {
    return failure('mutually exclusive arguments: --collapse-range --dig-holes --punch-hole --zero-range');
  }
  if (flags.has('c') && flags.has('n')) return failure('mutually exclusive arguments: --collapse-range --keep-size');
  if (flags.has('x') && flags.has('z')) {
    return failure('mutually exclusive arguments: --posix --collapse-range --dig-holes --insert-range --keep-size --punch-hole --zero-range');
  }
  const dig = flags.has('d');
  if (length === undefined && !dig) return failure('no length argument specified');

  const path = files[0];
  const abs = exec.vfs.normalizePath(path, exec.getCwd());
  const creating = !['n', 'p', 'z', 'c', 'i', 'd'].some((f) => flags.has(f));
  let inode = exec.vfs.resolveInode(abs);
  if (inode?.type === 'directory') return failure(`cannot open ${path}: Is a directory`);
  if (!inode && !creating) return failure(`cannot open ${path}: No such file or directory`);
  if (!inode && !exec.vfs.writeFile(abs, '', exec.userMgr.currentUid, exec.userMgr.currentGid, exec.getUmask(), false, undefined, false)) {
    return failure(`cannot open ${path}: No such file or directory`);
  }
  inode = exec.vfs.resolveInode(abs);
  if (!inode) return failure(`cannot open ${path}: No such file or directory`);

  exec.publishAuditFsAccess(abs, 'w', 'fallocate');
  exec.publishAuditSyscall('fallocate', abs);

  const size = inode.size;
  const span = length ?? 0;
  const keepSize = flags.has('n') || flags.has('p');
  const content = inode.content;
  let nextSize = size;
  let nextContent = content;
  let verb = 'allocated';

  if (flags.has('i')) {
    if (keepSize) return failure('fallocate failed: keep size mode is unsupported');
    if (flags.has('c') || flags.has('z')) return failure('fallocate failed: Operation not supported');
    if (offset % BLOCK !== 0 || span % BLOCK !== 0 || offset >= size) return failure('fallocate failed: Invalid argument');
    nextSize = size + span;
    nextContent = content.slice(0, offset) + '\0'.repeat(Math.max(0, Math.min(span, 1 << 20))) + content.slice(offset);
    verb = 'inserted';
  } else if (flags.has('c')) {
    if (offset % BLOCK !== 0 || span % BLOCK !== 0 || offset + span >= size) return failure('fallocate failed: Invalid argument');
    nextSize = size - span;
    nextContent = content.slice(0, offset) + content.slice(offset + span);
    verb = 'removed';
  } else if (flags.has('p')) {
    const end = Math.min(offset + span, content.length);
    if (offset < end) nextContent = content.slice(0, offset) + '\0'.repeat(end - offset) + content.slice(end);
    verb = 'hole created';
  } else if (flags.has('z')) {
    const end = Math.min(offset + span, content.length);
    if (offset < end) nextContent = content.slice(0, offset) + '\0'.repeat(end - offset) + content.slice(end);
    if (!keepSize) nextSize = Math.max(size, offset + span);
    verb = 'zeroed';
  } else if (dig) {
    let zeroBlocks = 0;
    for (let at = 0; at + BLOCK <= content.length; at += BLOCK) {
      if (/^\0+$/.test(content.slice(at, at + BLOCK))) zeroBlocks++;
    }
    length = zeroBlocks * BLOCK;
    verb = 'converted to sparse holes';
  } else if (!keepSize) {
    nextSize = Math.max(size, offset + span);
  }

  if (nextSize !== size || nextContent !== content) {
    const ok = exec.vfs.writeFile(
      abs, nextContent, exec.userMgr.currentUid, exec.userMgr.currentGid, exec.getUmask(),
      false, nextSize,
    );
    if (!ok) return failure('fallocate failed: No space left on device');
  }
  if (flags.has('v')) {
    const shown = length ?? span;
    return { output: `${path}: ${humanSizeForFallocate(shown)} (${shown} bytes) ${verb}.`, exitCode: 0 };
  }
  return { output: '', exitCode: 0 };
}

export const fallocateCommand: LinuxCommand = {
  name: 'fallocate',
  package: 'util-linux',
  needsNetworkContext: false,
  usage: 'fallocate [-o OFFSET] -l LENGTH FILE',
  options: FALLOCATE_OPTIONS,
  help: 'Preallocate or deallocate space to a file.',
  run: (ctx, args) => runFallocate(ctx.executor, args).output,
  runWithStatusSync: (ctx, args) => runFallocate(ctx.executor, args),
  runWithStatus: (ctx, args) => Promise.resolve(runFallocate(ctx.executor, args)),
};
