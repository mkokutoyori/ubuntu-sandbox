import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { Streams, docsResult, quoteLocale, quotef, type CoreutilsRun } from './CoreutilsKit';

export interface DfRow {
  readonly fs: string;
  readonly type: string;
  readonly mount: string;
  readonly sizeKb: number;
  readonly usedKb: number;
  readonly availKb: number;
  readonly inodesTotal: number;
  readonly inodesUsed: number;
}

export interface DfHost {
  filesystems(showAll: boolean): readonly DfRow[];
  filesystemOf(path: string): DfRow | null;
  exists(path: string): boolean;
}

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'all', letter: 'a', takesArgument: false },
  { name: 'block-size', letter: 'B', takesArgument: true },
  { name: 'inodes', letter: 'i', takesArgument: false },
  { name: 'human-readable', letter: 'h', takesArgument: false },
  { name: 'si', letter: 'H', takesArgument: false },
  { name: 'local', letter: 'l', takesArgument: false },
  { name: 'output', letter: 'O', takesArgument: false, optionalArgument: true },
  { name: 'portability', letter: 'P', takesArgument: false },
  { name: 'print-type', letter: 'T', takesArgument: false },
  { name: 'sync', letter: 'S', takesArgument: false },
  { name: 'no-sync', letter: 'N', takesArgument: false },
  { name: 'total', letter: 'Z', takesArgument: false },
  { name: 'type', letter: 't', takesArgument: true },
  { name: 'exclude-type', letter: 'x', takesArgument: true },
  { name: 'help', letter: '', takesArgument: false },
  { name: 'version', letter: '', takesArgument: false },
];

type Field = 'source' | 'fstype' | 'size' | 'used' | 'avail' | 'pcent' | 'itotal' | 'iused' | 'iavail' | 'ipcent' | 'target' | 'file';

interface FieldSpec {
  readonly caption: string;
  readonly width: number;
  readonly right: boolean;
  readonly inode: boolean;
  readonly block: boolean;
}

const FIELDS: Readonly<Record<Field, FieldSpec>> = {
  source: { caption: 'Filesystem', width: 14, right: false, inode: false, block: false },
  fstype: { caption: 'Type', width: 4, right: false, inode: false, block: false },
  size: { caption: 'blocks', width: 5, right: true, inode: false, block: true },
  used: { caption: 'Used', width: 5, right: true, inode: false, block: true },
  avail: { caption: 'Available', width: 5, right: true, inode: false, block: true },
  pcent: { caption: 'Use%', width: 4, right: true, inode: false, block: true },
  itotal: { caption: 'Inodes', width: 5, right: true, inode: true, block: false },
  iused: { caption: 'IUsed', width: 5, right: true, inode: true, block: false },
  iavail: { caption: 'IFree', width: 5, right: true, inode: true, block: false },
  ipcent: { caption: 'IUse%', width: 4, right: true, inode: true, block: false },
  target: { caption: 'Mounted on', width: 0, right: false, inode: false, block: false },
  file: { caption: 'File', width: 0, right: false, inode: false, block: false },
};

const REMOTE_TYPES: ReadonlySet<string> = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'fuse.sshfs', '9p', 'afs']);

const ALL_FIELDS: readonly Field[] = ['source', 'fstype', 'itotal', 'iused', 'iavail', 'ipcent', 'size', 'used', 'avail', 'pcent', 'file', 'target'];

const UNIT_POWER: Readonly<Record<string, number>> = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6, Z: 7, Y: 8, R: 9, Q: 10 };

interface BlockSpec {
  readonly unit: bigint;
  readonly suffix: string;
}

type BlockError = 'invalid' | 'suffix' | 'large';

function parseBlockSpec(text: string): BlockSpec | BlockError {
  const match = /^(0[xX][0-9a-fA-F]+|[0-9]*)([A-Za-z]*)$/.exec(text);
  if (match === null) return /^[0-9]/.test(text) ? 'suffix' : 'invalid';
  const digits = match[1];
  const tail = match[2];
  if (digits === '' && tail === '') return 'invalid';
  let count = digits === '' ? 1n : BigInt(digits);
  let multiplier = 1n;
  let suffix = '';
  if (tail !== '') {
    const m = /^([KMGTPEZYRQkmgtpezyrq])(iB|B)?$/.exec(tail);
    if (m === null) return digits === '' ? 'invalid' : 'suffix';
    const power = UNIT_POWER[m[1].toUpperCase()];
    const decimal = m[2] === 'B';
    multiplier = (decimal ? 1000n : 1024n) ** BigInt(power);
    if (digits === '') suffix = `${decimal && m[1].toLowerCase() === 'k' ? 'k' : m[1].toUpperCase()}${m[2] ?? ''}`;
  }
  count *= multiplier;
  if (count === 0n) return 'invalid';
  if (count >= 1n << 64n) return 'large';
  return { unit: count, suffix };
}

function humanReadable(amount: bigint, base: bigint, suffixCase: 'K' | 'k', suppressPointZero = false): string {
  if (amount < base) return amount.toString();
  const letters = [suffixCase, 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q'];
  let power = 0;
  let divisor = 1n;
  while (power < letters.length && amount >= divisor * base) { divisor *= base; power++; }
  const tenths = (amount * 10n + divisor - 1n) / divisor;
  const letter = letters[power - 1];
  if (tenths < 100n) return suppressPointZero && tenths % 10n === 0n ? `${tenths / 10n}${letter}` : `${tenths / 10n}.${tenths % 10n}${letter}`;
  return `${(amount + divisor - 1n) / divisor}${letter}`;
}

function unitCaption(unit: bigint): string {
  let q1000 = unit;
  let q1024 = unit;
  let by1000: boolean;
  let by1024: boolean;
  do {
    by1000 = q1000 % 1000n === 0n; q1000 /= 1000n;
    by1024 = q1024 % 1024n === 0n; q1024 /= 1024n;
  } while (by1000 && by1024);
  const binary = by1024 && !by1000;
  const text = humanReadable(unit, binary ? 1024n : 1000n, binary ? 'K' : 'k', true);
  const plain = /^[0-9]+$/.test(text);
  if (plain) return `${text}B`;
  return binary ? text : `${text}B`;
}

function failure(streams: Streams, line: string, usage: boolean): CoreutilsRun {
  streams.diagnostic(line);
  if (usage) streams.diagnostic("Try 'df --help' for more information.");
  streams.exitCode = 1;
  return streams.result();
}

interface Totals { size: bigint; used: bigint; avail: bigint; itotal: bigint; iused: bigint; iavail: bigint }

export function runDf(host: DfHost, args: readonly string[]): CoreutilsRun {
  const streams = new Streams();
  const include: string[] = [];
  const exclude: string[] = [];
  const operands: string[] = [];
  let showAll = false;
  let local = false;
  let printType = false;
  let posix = false;
  let inodes = false;
  let grandTotal = false;
  let outputMode = false;
  const outputFields: Field[] = [];
  let human: 'none' | 'binary' | 'si' = 'none';
  let blockUnit = 1024n;
  let blockSuffix = '';
  let blockGiven = false;
  const mutual = (flag: string): CoreutilsRun => failure(streams, `df: options ${flag} and --output are mutually exclusive`, true);
  for (const item of shortOptions(args, 'aB:iF:hHklmPTt:vx:', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return failure(streams, getoptDiagnostic('df', item), true);
    if (item.long === 'help') return docsResult('df', 'help');
    if (item.long === 'version') return docsResult('df', 'version');
    switch (item.letter) {
      case 'a': showAll = true; break;
      case 'B': {
        const parsed = parseBlockSpec(item.argument ?? '');
        if (typeof parsed === 'string') {
          const option = item.long === undefined ? '-B' : '--block-size';
          const argument = quoteLocale(item.argument ?? '');
          const line = parsed === 'invalid' ? `df: invalid ${option} argument ${argument}`
            : parsed === 'suffix' ? `df: invalid suffix in ${option} argument ${argument}` : `df: ${option} argument ${argument} too large`;
          return failure(streams, line, false);
        }
        blockUnit = parsed.unit; blockSuffix = parsed.suffix; human = 'none'; blockGiven = true;
        break;
      }
      case 'i':
        if (outputMode) return mutual('-i');
        inodes = true;
        break;
      case 'h': human = 'binary'; blockUnit = 1n; blockSuffix = ''; blockGiven = true; break;
      case 'H': human = 'si'; blockUnit = 1n; blockSuffix = ''; blockGiven = true; break;
      case 'k': human = 'none'; blockUnit = 1024n; blockSuffix = ''; blockGiven = true; break;
      case 'm': human = 'none'; blockUnit = 1048576n; blockSuffix = ''; blockGiven = true; break;
      case 'l': local = true; break;
      case 'T':
        if (outputMode) return mutual('-T');
        printType = true;
        break;
      case 'P':
        if (outputMode) return mutual('-P');
        posix = true;
        break;
      case 'O': {
        if (inodes) return mutual('-i');
        if (posix) return mutual('-P');
        if (printType) return mutual('-T');
        outputMode = true;
        if (item.argument !== undefined) {
          for (const name of item.argument.split(',')) {
            if (!(name in FIELDS)) return failure(streams, `df: option --output: field ${quoteLocale(name)} unknown`, true);
            if (outputFields.includes(name as Field)) return failure(streams, `df: option --output: field ${quoteLocale(name)} used more than once`, true);
            outputFields.push(name as Field);
          }
        }
        break;
      }
      case 't': case 'F': include.push(item.argument ?? ''); break;
      case 'x': exclude.push(item.argument ?? ''); break;
      case 'Z': grandTotal = true; break;
      default: break;
    }
  }
  if (!blockGiven && posix) { blockUnit = 1024n; blockSuffix = ''; }
  const autoscale = human !== 'none';
  for (const name of include) {
    if (exclude.includes(name)) {
      return failure(streams, `df: file system type ${quoteLocale(name)} both selected and excluded`, false);
    }
  }
  const fields: Field[] = outputMode
    ? (outputFields.length > 0 ? outputFields : [...ALL_FIELDS])
    : inodes ? ['source', ...(printType ? ['fstype' as const] : []), 'itotal', 'iused', 'iavail', 'ipcent', 'target']
      : ['source', ...(printType ? ['fstype' as const] : []), 'size', 'used', 'avail', 'pcent', 'target'];
  const selected = (row: DfRow): boolean => (include.length === 0 || include.includes(row.type)) && !exclude.includes(row.type)
    && !(local && REMOTE_TYPES.has(row.type));
  const rows: Array<{ row: DfRow; file: string }> = [];
  let status = 0;
  if (operands.length > 0) {
    for (const operand of operands) {
      if (!host.exists(operand)) {
        streams.diagnostic(`df: ${quotef(operand)}: No such file or directory`);
        status = 1;
        continue;
      }
      const row = host.filesystemOf(operand);
      if (row !== null && selected(row)) rows.push({ row, file: operand });
    }
  } else {
    for (const row of host.filesystems(showAll)) {
      if (!selected(row)) continue;
      if (!showAll && row.sizeKb === 0) continue;
      rows.push({ row, file: '-' });
    }
  }
  if (rows.length === 0) {
    if (status === 0) { streams.diagnostic('df: no file systems processed'); status = 1; }
    streams.exitCode = status;
    return streams.result();
  }
  const header = fields.map((field): string => {
    if (field === 'size') {
      if (outputMode ? !autoscale : human === 'none' && !posix) return `${blockSuffix !== '' ? `1${blockSuffix}` : unitCaption(blockUnit)}-blocks`;
      if (posix && !outputMode && !autoscale) return `${blockUnit}-blocks`;
      return 'Size';
    }
    if (field === 'avail' && (autoscale || outputMode)) return 'Avail';
    if (field === 'pcent' && posix && !outputMode && !autoscale) return 'Capacity';
    return FIELDS[field].caption;
  });
  const base = human === 'si' ? 1000n : 1024n;
  const caseLetter = human === 'si' ? 'k' : 'K';
  const render = (amountKb: bigint, inode: boolean): string => {
    const bytes = inode ? amountKb : amountKb * 1024n;
    if (autoscale) return humanReadable(bytes, base, caseLetter);
    if (inode) return amountKb.toString();
    return `${(bytes + blockUnit - 1n) / blockUnit}${blockSuffix}`;
  };
  const percent = (used: bigint, avail: bigint): string => {
    const total = used + avail;
    if (total === 0n) return '-';
    return `${(used * 100n + total - 1n) / total}%`;
  };
  const cells = (row: DfRow, file: string, total: boolean): string[] => {
    const size = BigInt(row.sizeKb);
    const used = BigInt(row.usedKb);
    const avail = BigInt(row.availKb);
    const itotal = BigInt(row.inodesTotal);
    const iused = BigInt(row.inodesUsed);
    const iavail = itotal > iused ? itotal - iused : 0n;
    return fields.map((field): string => {
      switch (field) {
        case 'source': return total ? 'total' : row.fs;
        case 'fstype': return total ? '-' : row.type;
        case 'size': return render(size, false);
        case 'used': return render(used, false);
        case 'avail': return render(avail, false);
        case 'pcent': return percent(used, avail);
        case 'itotal': return render(itotal, true);
        case 'iused': return render(iused, true);
        case 'iavail': return render(iavail, true);
        case 'ipcent': return percent(iused, iavail);
        case 'file': return total ? '-' : file;
        case 'target': return total ? (fields.includes('source') ? '-' : 'total') : row.mount;
      }
    });
  };
  const table: string[][] = [header];
  for (const { row, file } of rows) table.push(cells(row, file, false));
  if (grandTotal) {
    const sum: Totals = { size: 0n, used: 0n, avail: 0n, itotal: 0n, iused: 0n, iavail: 0n };
    for (const { row } of rows) {
      sum.size += BigInt(row.sizeKb); sum.used += BigInt(row.usedKb); sum.avail += BigInt(row.availKb);
      sum.itotal += BigInt(row.inodesTotal); sum.iused += BigInt(row.inodesUsed);
    }
    table.push(cells({
      fs: 'total', type: '-', mount: '-', sizeKb: Number(sum.size), usedKb: Number(sum.used), availKb: Number(sum.avail),
      inodesTotal: Number(sum.itotal), inodesUsed: Number(sum.iused),
    }, '-', true));
  }
  const widths = fields.map((field, column) => Math.max(FIELDS[field].width, ...table.map((line) => Array.from(line[column]).length)));
  for (const line of table) {
    const pieces = line.map((cell, column) => {
      const spec = FIELDS[fields[column]];
      const pad = ' '.repeat(Math.max(0, widths[column] - Array.from(cell).length));
      if (spec.right) return `${pad}${cell}`;
      return column === fields.length - 1 ? cell : `${cell}${pad}`;
    });
    streams.stdout(`${pieces.join(' ')}\n`);
  }
  streams.exitCode = status;
  return streams.result();
}
