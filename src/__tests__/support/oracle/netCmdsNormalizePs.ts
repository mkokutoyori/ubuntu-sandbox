/**
 * Column-aware normalisation of `ps` listings for the oracle replay. The recording comes from a bare pid namespace, the replay from a booted
 * machine, so what is compared is what the tool DECIDES and what the machine cannot vary:
 *
 *   pid, ppid, pgid, sid, tpgid, lwp...  replaced by the lab's names (<sh>, <P1>, <P3C>, <ps>), right-aligned in the cell they filled
 *   vsz, rss, sz, %mem, psr, signals...  every digit replaced by '#', so the width and the alignment stay under test but the value does not
 *   stime, start, etime, %cpu, c         digits replaced by '#' (the clock and the scheduler differ)
 *   tty                                  pts/N seen as pts/0
 *   the shell row                        owner root, ppid 0, command <shell> (the lab shell is `bash /tmp/<script>`, the machine's is a login shell)
 *   rows the namespace would not show    dropped on the simulator side, except the highest pid (the ps that is running)
 */
import { FORMAT_ARRAY } from '@/network/devices/linux/commands/system/ps/PsFormatTable';
import type { NormalizeSide } from './netCmdsNormalize';

const PID_COLUMNS: ReadonlySet<string> = new Set(['PID', 'PPID', 'PGID', 'SID', 'TPGID', 'LWP', 'SPID', 'TID', 'TGID', 'SESS', 'PGRP', 'TSID', 'TSESS']);
const DECIMAL_COLUMNS: ReadonlySet<string> = new Set([
  'VSZ', 'RSS', 'SZ', 'SZ:RSS', '%MEM', 'PSR', 'ADDR', 'DRS', 'TRS', 'SIZE', 'RSZ', 'TSIZ', 'DSIZ', 'LIM', 'MAJFL', 'MINFL', 'MAJFLT', 'MINFLT', 'PAGEIN',
  'STIME', 'START', 'STARTED', 'ELAPSED', '%CPU', 'C', 'CP', 'CPUID', 'NUMA', 'PSS', 'USS', 'SWAP', 'SHRD', 'LIB', 'DT', 'AGID', 'AGNI', 'OOM', 'OOMADJ',
  'RBYTES', 'WBYTES', 'RCHARS', 'WCHARS', 'ROPS', 'WOPS', 'WCBYTES', 'CGROUPNS', 'IPCNS', 'MNTNS', 'NETNS', 'PIDNS', 'TIMENS', 'USERNS', 'UTSNS',
  'SESSION', 'OWNER', '%CUC', '%CUU', 'UTIME', 'DATA', 'STACK', 'LCK', 'E_CODE', 'S_CODE', 'BND', 'RE', 'SL',
]);
const HEXADECIMAL_COLUMNS: ReadonlySet<string> = new Set(['PENDING', 'BLOCKED', 'IGNORED', 'CAUGHT', 'CATCHED', 'SIGNAL', 'STACKP', 'ESP', 'EIP']);
const SHELL_MASKED_COLUMNS: ReadonlySet<string> = new Set(['F', 'FLAGS']);
const OWNER_COLUMNS: ReadonlySet<string> = new Set([
  'UID', 'USER', 'EUID', 'RUID', 'SUID', 'FUID', 'EUSER', 'RUSER', 'SUSER', 'FUSER', 'GROUP', 'EGROUP', 'RGROUP', 'SGROUP', 'FGROUP',
  'GID', 'EGID', 'RGID', 'SGID', 'FGID', 'FSUID', 'FSUSER', 'FSGID', 'FSGROUP', 'SVUID', 'SVUSER', 'SVGID', 'SVGROUP',
]);
const HEADER_LINE = /^[ A-Z0-9%:_/-]*[A-Z][ A-Z0-9%:_/-]*$/;
const KNOWN_HEADS: ReadonlySet<string> = new Set(FORMAT_ARRAY.map((format) => format.head));
const SHELL_COMMAND_PREFIXES = ['bash /tmp/', '-bash'];
const LAB_SHELL_COMMAND = /^(bash \/tmp\/[\w.]+|-bash)$/;
const WARNING_LINE = /^warning: /;
const TERMINATOR = /^(rc=|error:|Usage:|\s*$)/;
const PS_INVOCATION = /(^|[;|&(]\s*|=('[^']*'|"[^"]*"|\S*)\s+)ps([\s;|&)]|$)/;

export function isPsInvocation(command: string): boolean {
  const lastStage = command.split('|').pop() ?? '';
  return PS_INVOCATION.test(command) && !/^\s*wc\b/.test(lastStage);
}

function withoutForestPrefix(text: string): { prefix: string; command: string } {
  const prefix = /^(\\_ |\s)*/.exec(text)?.[0] ?? '';
  return { prefix, command: text.slice(prefix.length) };
}

function isShellCommand(text: string): boolean {
  const { command } = withoutForestPrefix(text);
  return command.length >= 2 && (SHELL_COMMAND_PREFIXES.some((full) => full.startsWith(command)) || /^bash \/tmp\/[\w.]*$/.test(command));
}

interface Cell {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function cellsOf(line: string): Cell[] {
  const cells: Cell[] = [];
  let previousEnd = 0;
  for (const token of line.matchAll(/\S+/g)) {
    const start = token.index ?? 0;
    cells.push({ start: previousEnd, end: start + token[0].length, text: token[0] });
    previousEnd = start + token[0].length;
  }
  return cells;
}

function mergeStarted(cells: Cell[], columns: readonly string[]): Cell[] {
  const index = columns.indexOf('STARTED');
  if (index < 0 || cells.length < columns.length + 4) return cells;
  const merged: Cell = { start: cells[index].start, end: cells[index + 4].end, text: cells.slice(index, index + 5).map((cell) => cell.text).join(' ') };
  return [...cells.slice(0, index), merged, ...cells.slice(index + 5)];
}

function replaceCells(line: string, cells: readonly Cell[], replacements: ReadonlyMap<number, string>): string {
  let result = '';
  let cursor = 0;
  cells.forEach((cell, index) => {
    const replacement = replacements.get(index);
    if (replacement === undefined) return;
    result += line.slice(cursor, cell.start) + replacement.padStart(cell.end - cell.start);
    cursor = cell.end;
  });
  return result + line.slice(cursor);
}

function labelOf(pid: number, side: NormalizeSide, names: ReadonlyMap<number, string>): string {
  if (pid === side.shellPid) return '<sh>';
  const name = names.get(pid);
  return name === undefined ? '<ps>' : `<${name}>`;
}

function pidColumnOf(columns: readonly string[]): number {
  const index = columns.indexOf('PID');
  return index >= 0 ? index : columns.findIndex((name) => PID_COLUMNS.has(name) && name !== 'PPID' && name !== 'PGID' && name !== 'SID');
}

interface RowContext {
  readonly side: NormalizeSide;
  readonly names: ReadonlyMap<number, string>;
  readonly known: ReadonlySet<number>;
  readonly literals: ReadonlySet<number>;
  readonly lastRow: { shell: boolean };
}

function processRow(line: string, columns: readonly string[], context: RowContext): string {
  const { side, names, known, literals, lastRow } = context;
  const cells = mergeStarted(cellsOf(line), columns);
  if (cells.length < columns.length) return line;
  const replacements = new Map<number, string>();
  const pidIndex = pidColumnOf(columns);
  const ownLabel = pidIndex >= 0 && /^\d+$/.test(cells[pidIndex].text) ? labelOf(Number(cells[pidIndex].text), side, names) : null;
  const threadRow = pidIndex >= 0 && cells[pidIndex].text === '-';
  const shellRow = ownLabel === '<sh>' || (threadRow && lastRow.shell);
  if (!threadRow) lastRow.shell = ownLabel === '<sh>';
  const lastIndex = columns.length - 1;
  columns.forEach((name, index) => {
    const text = cells[index].text;
    if (PID_COLUMNS.has(name) && /^\d+$/.test(text)) {
      replacements.set(index, shellRow && name === 'PPID' ? '0' : labelOf(Number(text), side, names));
    } else if (name === 'STARTED') {
      replacements.set(index, text.replace(/[A-Za-z0-9]/g, '#'));
    } else if (DECIMAL_COLUMNS.has(name)) {
      replacements.set(index, text.replace(/\d/g, '#'));
    } else if (HEXADECIMAL_COLUMNS.has(name)) {
      replacements.set(index, text.replace(/[0-9a-f]/g, '#'));
    } else if (name === 'TTY' || name === 'TT') {
      replacements.set(index, text.replace(/^pts\/\d+$/, 'pts/0'));
    } else if (shellRow && SHELL_MASKED_COLUMNS.has(name)) {
      replacements.set(index, '#');
    } else if (shellRow && OWNER_COLUMNS.has(name)) {
      replacements.set(index, /^\d+$/.test(text) ? '0' : 'root');
    } else if (!KNOWN_HEADS.has(name) && /^\d+$/.test(text) && known.has(Number(text))) {
      replacements.set(index, labelOf(Number(text), side, names));
    }
  });
  const lastColumn = columns[lastIndex];
  const leading = line.slice(0, cells[lastIndex].start);
  const rest = line.slice(cells[lastIndex].start);
  const gap = /^\s*/.exec(rest)?.[0] ?? '';
  let tail = rest.slice(gap.length);
  if (PID_COLUMNS.has(lastColumn) || DECIMAL_COLUMNS.has(lastColumn) || HEXADECIMAL_COLUMNS.has(lastColumn) || OWNER_COLUMNS.has(lastColumn) || lastColumn === 'TTY') {
    return replaceCells(line, cells, replacements);
  }
  if (shellRow && isShellCommand(tail)) tail = `${withoutForestPrefix(tail).prefix}<shell>`;
  else if (pidIndex < 0 && LAB_SHELL_COMMAND.test(withoutForestPrefix(tail).command)) tail = `${withoutForestPrefix(tail).prefix}<shell>`;
  else if (ownLabel === '<ps>') tail = nameKnownPids(tail, side, names, literals);
  replacements.delete(lastIndex);
  return replaceCells(leading, cells.slice(0, lastIndex), replacements) + gap + tail;
}

function processHeaderlessRow(line: string, context: RowContext): string {
  const { side, names } = context;
  const cells = cellsOf(line);
  const replacements = new Map<number, string>();
  let shellRow = false;
  cells.slice(0, 3).forEach((cell, index) => {
    if (!/^\d+$/.test(cell.text)) return;
    const label = labelOf(Number(cell.text), side, names);
    shellRow = shellRow || label === '<sh>';
    replacements.set(index, label);
  });
  cells.forEach((cell, index) => {
    if (/^pts\/\d+$/.test(cell.text)) replacements.set(index, 'pts/0');
  });
  const suffixText = (from: number): string => cells.slice(from).map((cell) => cell.text).join(' ');
  const labShellAt = cells.findIndex((_, from) => LAB_SHELL_COMMAND.test(suffixText(from)));
  const prefixShellAt = shellRow ? cells.findIndex((_, from) => isShellCommand(suffixText(from))) : -1;
  const shellAt = labShellAt >= 0 ? labShellAt : prefixShellAt;
  if (shellAt >= 0) {
    const head = replaceCells(line.slice(0, cells[shellAt].start), cells.slice(0, shellAt), replacements);
    const gap = /^\s*/.exec(line.slice(cells[shellAt].start))?.[0] ?? '';
    return `${head}${gap}<shell>`;
  }
  return replaceCells(line, cells, replacements);
}

function firstPid(line: string): number | null {
  const cell = cellsOf(line).slice(0, 3).find((candidate) => /^\d+$/.test(candidate.text));
  return cell === undefined ? null : Number(cell.text);
}

function pidOf(line: string, columns: readonly string[]): number | null {
  const index = pidColumnOf(columns);
  if (index < 0) return null;
  const cells = cellsOf(line);
  return cells.length > index && /^\d+$/.test(cells[index].text) ? Number(cells[index].text) : null;
}

function nameKnownPids(row: string, side: NormalizeSide, names: ReadonlyMap<number, string>, literals: ReadonlySet<number>): string {
  return row.replace(/\b\d+\b/g, (digits) => {
    const pid = Number(digits);
    return !literals.has(pid) && (pid === side.shellPid || names.has(pid)) ? labelOf(pid, side, names) : digits;
  });
}

function literalNumbers(command: string): Set<number> {
  return new Set((command.match(/(?<![$\w])\d+/g) ?? []).map(Number));
}

export function normalizePs(output: string, side: NormalizeSide, names: ReadonlyMap<number, string>, command: string): string {
  const lines = output.split('\n').map((line) => line.replace(/\s+$/, ''));
  const known = new Set<number>([...names.keys(), ...(side.shellPid === undefined ? [] : [side.shellPid]), ...(side.visible ?? [])]);
  const context: RowContext = { side, names, known, literals: literalNumbers(command), lastRow: { shell: false } };
  const result: string[] = [];
  let header: string | null = null;
  let columns: string[] = [];
  let headerless = false;
  let unknownRows: { index: number; pid: number }[] = [];
  const newest = Math.max(0, ...(side.visible ?? []));
  const settle = (): void => {
    if (side.visible === undefined || unknownRows.length === 0) {
      unknownRows = [];
      return;
    }
    const candidates = unknownRows.filter((row) => row.pid > newest);
    const keep = candidates.length === 0 ? null : candidates.reduce((best, row) => (row.pid > best.pid ? row : best));
    const drop = new Set(unknownRows.filter((row) => row !== keep).map((row) => row.index));
    for (const index of [...drop].sort((a, b) => b - a)) result.splice(index, 1);
    unknownRows = [];
  };
  lines.forEach((line, lineIndex) => {
    if (header === null && HEADER_LINE.test(line) && lines.slice(0, lineIndex).every((earlier) => WARNING_LINE.test(earlier))) {
      header = line;
      columns = line.trim().split(/\s+/);
      result.push(line);
      return;
    }
    if (lineIndex === 0 && header === null && /^\s*(\S+\s+)?\d+(\s|$)/.test(line)) {
      header = '';
      headerless = true;
    }
    if (header !== null && !headerless && line === header) {
      result.push(line);
      return;
    }
    if (header === null || TERMINATOR.test(line)) {
      if (header !== null) {
        settle();
        header = null;
      }
      result.push(line);
      return;
    }
    const pid = headerless ? firstPid(line) : pidOf(line, columns);
    if (pid !== null && pid === side.initPid) return;
    if (pid !== null && !known.has(pid)) unknownRows.push({ index: result.length, pid });
    const processed = headerless ? processHeaderlessRow(line, context) : processRow(line, columns, context);
    result.push(processed);
  });
  settle();
  return result.join('\n').replace(/\n+$/, '');
}
