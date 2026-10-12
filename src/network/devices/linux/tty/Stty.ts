import type { WindowSize } from '../shell/LinuxShellSession';

export interface TtyCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const FALLBACK_COLUMNS = 80;

const CONTROL_CHARACTERS = [
  'intr = ^C;', 'quit = ^\\;', 'erase = ^?;', 'kill = ^U;', 'eof = ^D;', 'eol = <undef>;', 'eol2 = <undef>;',
  'swtch = <undef>;', 'start = ^Q;', 'stop = ^S;', 'susp = ^Z;', 'rprnt = ^R;', 'werase = ^W;', 'lnext = ^V;',
  'discard = ^O;', 'min = 1;', 'time = 0;',
];

const FLAG_GROUPS = [
  '-parenb -parodd -cmspar cs8 -hupcl -cstopb cread -clocal -crtscts',
  '-ignbrk -brkint -ignpar -parmrk -inpck -istrip -inlcr -igncr icrnl ixon -ixoff -iuclc -ixany -imaxbel iutf8',
  'opost -olcuc -ocrnl onlcr -onocr -onlret -ofill -ofdel nl0 cr0 tab0 bs0 vt0 ff0',
  'isig icanon iexten echo echoe echok -echonl -noflsh -xcase -tostop -echoprt echoctl echoke -flusho -extproc',
];

function wrapItems(items: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const item of items) {
    if (current !== '' && current.length + 1 + item.length > width) {
      lines.push(current);
      current = item;
    } else {
      current = current === '' ? item : `${current} ${item}`;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

export function renderSttyAll(size: WindowSize): string {
  const width = size.cols > 0 ? size.cols : FALLBACK_COLUMNS;
  return [
    ...wrapItems(['speed 38400 baud;', `rows ${size.rows};`, `columns ${size.cols};`, 'line = 0;'], width),
    ...wrapItems(CONTROL_CHARACTERS, width),
    ...FLAG_GROUPS.flatMap((group) => wrapItems(group.split(' '), width)),
  ].join('\n');
}

const HELP_HINT = "Try 'stty --help' for more information.";

function failure(message: string): TtyCommandResult {
  return { stdout: '', stderr: message, exitCode: 1 };
}

export function runStty(args: readonly string[], size: WindowSize, apply: (size: WindowSize) => void): TtyCommandResult {
  if (args.length === 0) return { stdout: 'speed 38400 baud; line = 0;\n-brkint -imaxbel iutf8', stderr: '', exitCode: 0 };
  let rows = size.rows;
  let cols = size.cols;
  const printed: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === 'size') {
      printed.push(`${size.rows} ${size.cols}`);
    } else if (word === '-a' || word === '--all') {
      printed.push(renderSttyAll(size));
    } else if (word === 'rows' || word === 'cols' || word === 'columns') {
      const raw = args[i + 1];
      if (raw === undefined) return failure(`stty: missing argument to '${word}'\n${HELP_HINT}`);
      if (!/^\d+$/.test(raw)) return failure(`stty: invalid integer argument: '${raw}'`);
      if (word === 'rows') rows = Number(raw);
      else cols = Number(raw);
      i++;
    }
  }
  if (rows !== size.rows || cols !== size.cols) apply({ rows, cols });
  return { stdout: printed.join('\n'), stderr: '', exitCode: 0 };
}

export function runTput(args: readonly string[], size: WindowSize): TtyCommandResult {
  const lines: string[] = [];
  let stderr = '';
  let exitCode = 0;
  for (const capability of args) {
    if (capability.startsWith('-')) continue;
    if (capability === 'cols') lines.push(String(size.cols));
    else if (capability === 'lines') lines.push(String(size.rows));
    else if (['clear', 'init', 'reset', 'sgr0', 'bold', 'smso', 'rmso', 'cnorm', 'civis'].includes(capability)) continue;
    else {
      stderr = `tput: unknown terminfo capability '${capability}'`;
      exitCode = 4;
      break;
    }
  }
  return { stdout: lines.join('\n'), stderr, exitCode };
}
