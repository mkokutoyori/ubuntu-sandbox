import { shortOptions, getoptDiagnostic } from '../commands/Getopt';
import { gnuOptionSet } from '../GnuOptionGuard';
import { Streams, type CoreutilsRun } from './CoreutilsKit';

const FILE_USAGE = [
  'Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]',
  '            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]',
  '            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]',
  '            <file> ...',
  '       file -C [-m <magicfiles>]',
  '       file [--help]',
].join('\n');

const HELP_TEXT = `Usage: file [OPTION...] [FILE...]
Determine type of FILEs.

      --help                 display this help and exit
  -v, --version              output version information and exit
  -m, --magic-file LIST      use LIST as a colon-separated list of magic
                               number files
  -z, --uncompress           try to look inside compressed files
  -Z, --uncompress-noreport  only print the contents of compressed files
  -b, --brief                do not prepend filenames to output lines
  -c, --checking-printout    print the parsed form of the magic file, use in
                               conjunction with -m to debug a new magic file
                               before installing it
  -e, --exclude TEST         exclude TEST from the list of test to be
                               performed for file. Valid tests are:
                               apptype, ascii, cdf, compress, csv, elf,
                               encoding, soft, tar, json, simh,
                               text, tokens
      --exclude-quiet TEST   like exclude, but ignore unknown tests
  -f, --files-from FILE      read the filenames to be examined from FILE
  -F, --separator STRING     use string as separator instead of \`:'
  -i, --mime                 output MIME type strings (--mime-type and
                               --mime-encoding)
      --apple                output the Apple CREATOR/TYPE
      --extension            output a slash-separated list of extensions
      --mime-type            output the MIME type
      --mime-encoding        output the MIME encoding
  -k, --keep-going           don't stop at the first match
  -l, --list                 list magic strength
  -L, --dereference          follow symlinks (default if POSIXLY_CORRECT is set)
  -h, --no-dereference       don't follow symlinks (default if POSIXLY_CORRECT is not set) (default)
  -n, --no-buffer            do not buffer output
  -N, --no-pad               do not pad output
  -0, --print0               terminate filenames with ASCII NUL
  -p, --preserve-date        preserve access times on files
  -P, --parameter            set file engine parameter limits
                                   bytes 7340032 max bytes to look inside file
                               elf_notes     256 max ELF notes processed
                               elf_phnum    2048 max ELF prog sections processed
                               elf_shnum   32768 max ELF sections processed
                               elf_shsize 134217728 max ELF section size
                                encoding   65536 max bytes to scan for encoding
                                   indir      50 recursion limit for indirection
                                    name      50 use limit for name/use magic
                                   regex    8192 length limit for REGEX searches
  -r, --raw                  don't translate unprintable chars to \\ooo
  -s, --special-files        treat special (block/char devices) files as
                             ordinary ones
  -S, --no-sandbox           disable system call sandboxing
  -C, --compile              compile file specified by -m
  -d, --debug                print debugging messages

Report bugs to https://bugs.astron.com/
`;

const VERSION_TEXT = 'file-5.41\nmagic file from /etc/magic:/usr/share/misc/magic\n';

const EXCLUDABLE_TESTS: ReadonlySet<string> = new Set([
  'apptype', 'ascii', 'cdf', 'compress', 'csv', 'elf', 'encoding', 'soft', 'tar', 'json', 'simh', 'text', 'tokens',
]);

const PARAMETERS: ReadonlySet<string> = new Set([
  'bytes', 'elf_notes', 'elf_phnum', 'elf_shnum', 'elf_shsize', 'encoding', 'indir', 'name', 'regex',
]);

export interface FileDescribeOptions {
  readonly follow: boolean;
  readonly special: boolean;
  readonly excluded: ReadonlySet<string>;
  readonly byteLimit: number | null;
}

export interface FileHost {
  describe(target: string, options: FileDescribeOptions): string | null;
  describeStream(content: string, options: FileDescribeOptions): string;
  readFile(path: string): string | null;
  exists(path: string): boolean;
}

const SCRIPT_KINDS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^(sh)$/, 'POSIX shell script, ASCII text executable', 'text/x-shellscript'],
  [/^(bash)$/, 'Bourne-Again shell script, ASCII text executable', 'text/x-shellscript'],
  [/^python[0-9.]*$/, 'Python script, ASCII text executable', 'text/x-script.python'],
  [/^perl$/, 'Perl script text executable', 'text/x-perl'],
  [/^zsh$/, "Paul Falstad's zsh script, ASCII text executable", 'text/x-shellscript'],
  [/^awk$/, 'awk script, ASCII text executable', 'text/x-awk'],
  [/^ksh$/, 'Korn shell script, ASCII text executable', 'text/x-shellscript'],
  [/^ruby$/, 'Ruby script, ASCII text executable', 'text/x-ruby'],
  [/^node$/, 'Node.js script executable, ASCII text', 'application/javascript'],
  [/^csh$/, 'C shell script, ASCII text executable', 'text/x-shellscript'],
  [/^tclsh$/, 'Tcl/Tk script, ASCII text executable', 'text/x-tcl'],
];

export function scriptDescription(shebang: string): string {
  const words = shebang.trim().split(/\s+/);
  const interpreter = words[0] ?? '';
  const named = interpreter.split('/').pop() === 'env' ? words.slice(1).find((word) => !word.startsWith('-')) ?? interpreter : interpreter;
  const base = named.split('/').pop() ?? named;
  const kind = SCRIPT_KINDS.find(([pattern]) => pattern.test(base));
  return kind === undefined ? `a ${interpreter} script, ASCII text executable` : kind[1];
}

function mimeTypeOf(description: string, fromStream: boolean): string {
  if (description === 'empty') return fromStream ? 'application/x-empty' : 'inode/x-empty';
  if (description === 'directory') return 'inode/directory';
  if (description.endsWith('symbolic link') || description.includes('symbolic link to')) return 'inode/symlink';
  if (description.startsWith('character special')) return 'inode/chardevice';
  if (description.startsWith('block special')) return 'inode/blockdevice';
  if (description === 'socket') return 'inode/socket';
  if (description.startsWith('fifo')) return 'inode/fifo';
  const script = SCRIPT_KINDS.find(([, text]) => description.startsWith(text.split(',')[0]));
  if (script !== undefined) return script[2];
  if (description.startsWith('ASCII text') || description.includes('Unicode text') || description.startsWith('ISO-8859 text') || /script/.test(description)) return 'text/plain';
  return 'application/octet-stream';
}

function mimeEncodingOf(description: string): string {
  if (description.includes('UTF-8 Unicode text')) return 'utf-8';
  if (description.startsWith('ISO-8859 text')) return 'iso-8859-1';
  if (description.startsWith('ASCII text') || /script,? (ASCII text|text|executable)/.test(description)) return 'us-ascii';
  return 'binary';
}

function failure(line: string, status: number): CoreutilsRun {
  const streams = new Streams();
  streams.diagnostic(line);
  streams.exitCode = status;
  return streams.result();
}

function usageFailure(prefix: string | null): CoreutilsRun {
  return failure(prefix === null ? FILE_USAGE : `${prefix}\n${FILE_USAGE}`, 1);
}

export function runFile(host: FileHost, args: readonly string[], stdin: string | undefined): CoreutilsRun {
  const set = gnuOptionSet('file');
  const flags = new Set<string>();
  const excluded = new Set<string>();
  const operands: string[] = [];
  const listFiles: string[] = [];
  let separator = ':';
  let magicFiles: string | null = null;
  let byteLimit: number | null = null;
  let mimeType = false;
  let mimeEncoding = false;
  let stdinConsumed = false;
  for (const item of shortOptions(args, set.optstring, set.long)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') {
      return usageFailure(getoptDiagnostic('file', item));
    }
    const key = item.letter !== '' ? item.letter : item.long ?? '';
    if (key === 'help') return { stdout: HELP_TEXT, stderr: '', interleaved: HELP_TEXT, exitCode: 0 };
    if (key === 'v') return { stdout: VERSION_TEXT, stderr: '', interleaved: VERSION_TEXT, exitCode: 0 };
    if (key === 'i') { mimeType = true; mimeEncoding = true; }
    else if (key === 'mime-type') mimeType = true;
    else if (key === 'mime-encoding') mimeEncoding = true;
    else if (key === 'e' || key === 'exclude-quiet') {
      const name = item.argument ?? '';
      if (EXCLUDABLE_TESTS.has(name)) excluded.add(name);
      else if (key === 'e') return usageFailure(null);
    } else if (key === 'F') separator = item.argument ?? ':';
    else if (key === 'f') {
      const source = item.argument ?? '';
      const text = source === '-' ? (stdinConsumed ? '' : stdin ?? '') : host.readFile(source);
      if (source === '-') stdinConsumed = true;
      if (text === null) return failure(`file: Cannot open \`${source}' (No such file or directory)`, 1);
      listFiles.push(...text.replace(/\n$/, '').split('\n').filter((_, index, all) => !(all.length === 1 && text === '')).map((line) => line.split('\0')[0]));
    } else if (key === 'm') magicFiles = item.argument ?? '';
    else if (key === 'P') {
      const [name, value] = (item.argument ?? '').split('=');
      if (!PARAMETERS.has(name) || value === undefined) return failure(`file: Unknown param ${item.argument}`, 1);
      if (name === 'bytes') byteLimit = Number.parseInt(value, 10) || 0;
    } else if (['c', 'C', 'l', 'd'].includes(key)) return usageFailure(null);
    else if (key === 'h') flags.delete('L');
    else flags.add(key);
  }
  if (magicFiles !== null && !magicFiles.split(':').some((path) => host.exists(path))) {
    return failure('file: could not find any valid magic files! (No such file or directory)', 1);
  }
  const names = [...listFiles, ...operands];
  if (names.length === 0) return usageFailure(null);
  const has = (...keys: string[]): boolean => keys.some((key) => flags.has(key));
  const options: FileDescribeOptions = { follow: has('L'), special: has('s'), excluded, byteLimit };
  const brief = has('b');
  const printNul = has('0');
  const padded = !has('N');
  const strict = has('E');
  const width = Math.max(...names.map((name) => name.length));
  const streams = new Streams();
  for (const name of names) {
    const fromStream = name === '-';
    const description = fromStream ? host.describeStream(stdin ?? '', options) : host.describe(name, options);
    let text: string;
    if (description === null) {
      text = strict ? `ERROR: cannot stat \`${name}' (No such file or directory)` : `cannot open \`${name}' (No such file or directory)`;
      if (strict) streams.exitCode = 1;
    } else if (flags.has('extension')) text = '???';
    else if (flags.has('apple')) text = 'UNKNUNKN';
    else if (mimeType || mimeEncoding) {
      const brokenLink = description.startsWith('broken symbolic link');
      const type = mimeTypeOf(description, fromStream);
      const encoding = mimeEncodingOf(description);
      text = mimeType && mimeEncoding ? (brokenLink ? type : `${type}; charset=${encoding}`) : mimeType ? type : encoding;
    } else text = description;
    if (brief) { streams.stdout(`${text}\n`); continue; }
    const label = fromStream ? '/dev/stdin' : name;
    const padding = padded ? ' '.repeat(Math.max(0, width - name.length)) : '';
    streams.stdout(`${label}${printNul ? '\0' : ''}${separator}${padding} ${text}\n`);
  }
  return streams.result();
}
