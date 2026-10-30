import { FORMAT_ARRAY } from './PsFormatTable';
import type { PsState } from './PsState';
import { PsExit } from './PsTypes';

export const PROCPS_NG_VERSION = 'ps from procps-ng 4.0.4\n';

const SECTION_WORDS = ['simple', 'list', 'output', 'threads', 'misc', 'all'] as const;
const SECTION_ABBREVIATIONS = ['s', 'l', 'o', 't', 'm', 'a'] as const;

function sectionOf(option: string | null): number {
  if (option === null) return SECTION_WORDS.length;
  for (let index = 0; index < SECTION_WORDS.length; index++) {
    if (option === SECTION_WORDS[index] || option === SECTION_ABBREVIATIONS[index]) return index;
  }
  return SECTION_WORDS.length;
}

const SIMPLE = [
  '\nBasic options:\n',
  ' -A, -e               all processes\n',
  ' -a                   all with tty, except session leaders\n',
  '  a                   all with tty, including other users\n',
  ' -d                   all except session leaders\n',
  ' -N, --deselect       negate selection\n',
  '  r                   only running processes\n',
  '  T                   all processes on this terminal\n',
  '  x                   processes without controlling ttys\n',
];

const LIST = [
  '\nSelection by list:\n',
  ' -C <command>         command name\n',
  ' -G, --Group <GID>    real group id or name\n',
  ' -g, --group <group>  session or effective group name\n',
  ' -p, p, --pid <PID>   process id\n',
  '        --ppid <PID>  parent process id\n',
  ' -q, q, --quick-pid <PID>\n                      process id (quick mode)\n',
  ' -s, --sid <session>  session id\n',
  ' -t, t, --tty <tty>   terminal\n',
  ' -u, U, --user <UID>  effective user id or name\n',
  ' -U, --User <UID>     real user id or name\n',
  "\n  The selection options take as their argument either:\n    a comma-separated list e.g. '-u root,nobody' or\n    a blank-separated list e.g. '-p 123 4567'\n",
];

const OUTPUT = [
  '\nOutput formats:\n',
  ' -D <format>          date format for lstart\n',
  ' -F                   extra full\n',
  ' -f                   full-format, including command lines\n',
  '  f, --forest         ascii art process tree\n',
  ' -H                   show process hierarchy\n',
  ' -j                   jobs format\n',
  '  j                   BSD job control format\n',
  ' -l                   long format\n',
  '  l                   BSD long format\n',
  ' -M, Z                add security data (for SELinux)\n',
  ' -O <format>          preloaded with default columns\n',
  '  O <format>          as -O, with BSD personality\n',
  ' -o, o, --format <format>\n                      user-defined format\n',
  '  -P                  add psr column\n',
  '  s                   signal format\n',
  '  u                   user-oriented format\n',
  '  v                   virtual memory format\n',
  '  X                   register format\n',
  ' -y                   do not show flags, show rss vs. addr (used with -l)\n',
  '     --context        display security context (for SELinux)\n',
  '     --headers        repeat header lines, one per page\n',
  '     --no-headers     do not print header at all\n',
  '     --cols, --columns, --width <num>\n                      set screen width\n',
  '     --rows, --lines <num>\n                      set screen height\n',
  '     --signames       display signal masks using signal names\n',
];

const THREADS = [
  '\nShow threads:\n',
  '  H                   as if they were processes\n',
  ' -L                   possibly with LWP and NLWP columns\n',
  ' -m, m                after processes\n',
  ' -T                   possibly with SPID column\n',
];

const MISC = [
  '\nMiscellaneous options:\n',
  ' -c                   show scheduling class with -l option\n',
  '  c                   show true command name\n',
  '  e                   show the environment after command\n',
  '  k,    --sort        specify sort order as: [+|-]key[,[+|-]key[,...]]\n',
  '  L                   show format specifiers\n',
  '  n                   display numeric uid and wchan\n',
  '  S,    --cumulative  include some dead child process data\n',
  ' -y                   do not show flags, show rss (only with -l)\n',
  ' -V, V, --version     display version information and exit\n',
  ' -w, w                unlimited output width\n',
];

export function doHelp(state: PsState, option: string | null, code: number): never {
  const write = (text: string): void => (code === 0 ? state.output.out(text) : state.output.err(text));
  const section = sectionOf(option);
  const all = SECTION_WORDS.length - 1;
  write('\nUsage:\n ps [options]\n');
  if (section === 0 || section === all) for (const line of SIMPLE) write(line);
  if (section === 1 || section === all) for (const line of LIST) write(line);
  if (section === 2 || section === all) for (const line of OUTPUT) write(line);
  if (section === 3 || section === all) for (const line of THREADS) write(line);
  if (section === 4 || section === all) {
    for (const line of MISC) write(line);
    write(`\n        --help <${SECTION_WORDS.join('|')}>\n                      display help and exit\n`);
  }
  if (section === SECTION_WORDS.length) {
    write(`\n Try 'ps --help <${SECTION_WORDS.join('|')}>'\n  or 'ps --help <${SECTION_ABBREVIATIONS.join('|')}>'\n for additional help text.\n`);
  }
  write('\nFor more details see ps(1).\n');
  throw new PsExit(code);
}

export function printFormatSpecifiers(state: PsState): void {
  for (const entry of FORMAT_ARRAY) {
    if (entry.printer === 'nop') continue;
    state.output.out(`${entry.spec.slice(0, 12).padEnd(12)} ${entry.head.slice(0, 8).padEnd(8)}\n`);
  }
}

function ttyMajor(device: number): number {
  return (device >>> 8) & 0xfff;
}

function ttyMinor(device: number): number {
  return (device & 0xff) | ((device & 0xfff00000) >>> 12);
}

export function selfInfo(state: PsState): void {
  const none = (value: string | null): string => value ?? '(none)';
  const host = state.host;
  const hex = (state.personality >>> 0).toString(16).padStart(8, '0');
  state.output.err(
    `BSD j    ${none(state.bsdJFormat)}\n`
    + `BSD l    ${none(state.bsdLFormat)}\n`
    + `BSD s    ${none(state.bsdSFormat)}\n`
    + `BSD u    ${none(state.bsdUFormat)}\n`
    + `BSD v    ${none(state.bsdVFormat)}\n`
    + `SysV -f  ${none(state.sysvFFormat)}\n`
    + `SysV -fl ${none(state.sysvFlFormat)}\n`
    + `SysV -j  ${none(state.sysvJFormat)}\n`
    + `SysV -l  ${none(state.sysvLFormat)}\n`
    + '\n'
    + 'procps-ng version 4.0.4\n'
    + 'Compiled with: glibc 2.39, gcc 13.3\n\n'
    + `header_gap=${state.headerGap} lines_to_next_header=${state.linesToNextHeader}\n`
    + `screen_cols=${state.screenCols} screen_rows=${state.screenRows}\n`
    + '\n'
    + `personality=0x${hex} (from "${state.savedPersonalityText}")\n`
    + `EUID=${state.cachedEuid} TTY=${ttyMajor(state.cachedTty)},${ttyMinor(state.cachedTty)} page_size=${host.pageSizeBytes}\n`
    + 'sizeof(proc_t)=8 sizeof(long)=8 sizeof(long)=8\n'
    + 'archdefs: x86_64\n',
  );
}
