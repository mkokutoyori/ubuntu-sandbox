import type { HardwareProfile } from '@/network/devices/host/hardware/HardwareProfile';
import type { StorageDevice, DiskPartition } from '@/network/devices/host/hardware/StorageDevice';
import { getoptDiagnostic, shortOptions, type LongOption } from '../Getopt';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { renderTableText } from '@/network/devices/shells/cli/TextTable';

const COLUMNS = new Map<string, (row: Row) => string>([
  ['NAME',        r => r.name],
  ['MAJ:MIN',     r => r.majMin],
  ['RM',          r => r.removable],
  ['SIZE',        r => r.size],
  ['RO',          r => r.readOnly],
  ['TYPE',        r => r.type],
  ['MOUNTPOINT',  r => r.mountPoint],
  ['MOUNTPOINTS', r => r.mountPoint],
  ['UUID',        r => r.uuid],
  ['FSTYPE',      r => r.fsType],
  ['LABEL',       r => r.label],
  ['MODEL',       r => r.model],
  ['SERIAL',      r => r.serial],
  ['VENDOR',      r => r.vendor],
  ['OWNER',       r => 'root'],
  ['GROUP',       r => 'disk'],
  ['MODE',        r => r.type === 'disk' ? 'brw-rw----' : 'brw-rw----'],
  ['PATH',        r => `/dev/${r.name}`],
  ['LOG-SEC',     r => '512'],
  ['PHY-SEC',     r => '512'],
  ['SSZ',         r => '512'],
  ['ALIGNMENT',   r => '0'],
  ['MIN-IO',      r => '512'],
  ['OPT-IO',      r => '0'],
  ['RA',          r => '128'],
]);

interface Row {
  name: string;
  majMin: string;
  removable: string;
  size: string;
  readOnly: string;
  type: 'disk' | 'part' | 'loop' | 'rom';
  mountPoint: string;
  uuid: string;
  fsType: string;
  label: string;
  model: string;
  serial: string;
  vendor: string;
  bytes: number;
}

interface Options {
  all: boolean;
  fs: boolean;
  pathPrefix: boolean;
  bytes: boolean;
  list: boolean;
  raw: boolean;
  json: boolean;
  diskOnly: boolean;
  topology: boolean;
  perms: boolean;
  pairs: boolean;
  columns: string[] | null;
  noHeadings: boolean;
  sortColumn: string | null;
}

const DEFAULT_COLUMNS = ['NAME', 'MAJ:MIN', 'RM', 'SIZE', 'RO', 'TYPE', 'MOUNTPOINT'];

const OPTSTRING = 'abdDzE:e:fhiI:JlLmMnNo:OPprsStTVwx:y';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'all', letter: 'a', takesArgument: false },
  { name: 'bytes', letter: 'b', takesArgument: false },
  { name: 'nodeps', letter: 'd', takesArgument: false },
  { name: 'discard', letter: 'D', takesArgument: false },
  { name: 'zoned', letter: 'z', takesArgument: false },
  { name: 'dedup', letter: 'E', takesArgument: true },
  { name: 'exclude', letter: 'e', takesArgument: true },
  { name: 'fs', letter: 'f', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'ascii', letter: 'i', takesArgument: false },
  { name: 'include', letter: 'I', takesArgument: true },
  { name: 'json', letter: 'J', takesArgument: false },
  { name: 'list', letter: 'l', takesArgument: false },
  { name: 'perms', letter: 'm', takesArgument: false },
  { name: 'noheadings', letter: 'n', takesArgument: false },
  { name: 'nvme', letter: 'N', takesArgument: false },
  { name: 'output', letter: 'o', takesArgument: true },
  { name: 'output-all', letter: 'O', takesArgument: false },
  { name: 'pairs', letter: 'P', takesArgument: false },
  { name: 'paths', letter: 'p', takesArgument: false },
  { name: 'raw', letter: 'r', takesArgument: false },
  { name: 'inverse', letter: 's', takesArgument: false },
  { name: 'scsi', letter: 'S', takesArgument: false },
  { name: 'topology', letter: 't', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
  { name: 'width', letter: 'w', takesArgument: true },
  { name: 'sort', letter: 'x', takesArgument: true },
];

const TRY_HELP = "Try 'lsblk --help' for more information.";

function unknownColumn(name: string): { output: string; exitCode: number } {
  return { output: `lsblk: unknown column: ${name}`, exitCode: 1 };
}

export function cmdLsblk(profile: HardwareProfile, args: string[]): { output: string; exitCode: number } {
  const opts: Options = {
    all: false, fs: false, pathPrefix: false, bytes: false, list: false,
    raw: false, json: false, diskOnly: false, topology: false, perms: false,
    columns: null, noHeadings: false, sortColumn: null, pairs: false,
  };
  const operands: string[] = [];
  const majorsExcluded = new Set<string>();
  let majorsIncluded: Set<string> | null = null;
  for (const item of shortOptions(args, OPTSTRING, LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return { output: `${getoptDiagnostic('lsblk', item)}\n${TRY_HELP}`, exitCode: 1 };
    const value = item.argument ?? '';
    switch (item.letter) {
      case 'h': return { output: helpText(), exitCode: 0 };
      case 'V': return { output: 'lsblk from util-linux 2.37.2', exitCode: 0 };
      case 'a': opts.all = true; break;
      case 'f': opts.fs = true; break;
      case 'p': opts.pathPrefix = true; break;
      case 'b': opts.bytes = true; break;
      case 'l': opts.list = true; break;
      case 'r': opts.raw = true; break;
      case 'J': opts.json = true; break;
      case 'P': opts.pairs = true; break;
      case 'd': opts.diskOnly = true; break;
      case 't': opts.topology = true; break;
      case 'm': opts.perms = true; break;
      case 'n': opts.noHeadings = true; break;
      case 'e': for (const m of value.split(',')) majorsExcluded.add(m); break;
      case 'I': majorsIncluded = new Set(value.split(',')); break;
      case 'x': {
        const column = value.toUpperCase();
        if (!COLUMNS.has(column)) return { output: `${unknownColumn(value).output}\n${TRY_HELP}`, exitCode: 1 };
        opts.sortColumn = column;
        break;
      }
      case 'o': {
        const spec = value.toUpperCase();
        const names = spec.replace(/^\+/, '').split(',').filter((c) => c !== '');
        const unknown = names.find((c) => !COLUMNS.has(c));
        if (unknown !== undefined) return unknownColumn(unknown);
        opts.columns = spec.startsWith('+') ? [...(opts.columns ?? DEFAULT_COLUMNS), ...names] : names;
        break;
      }
      default: break;
    }
  }

  const listLike = opts.list || opts.raw || opts.json || opts.sortColumn !== null || opts.pairs;
  const rows: Row[] = [];
  let maj = 8;
  const known = new Set<string>(['loop0']);
  for (const d of profile.storage) {
    known.add(d.name);
    for (const part of d.partitions) known.add(part.name);
  }
  const wanted = operands.map((operand) => operand.replace(/^\/dev\//, ''));
  const refusals: string[] = [];
  for (const [index, name] of wanted.entries()) {
    if (!operands[index].startsWith('/dev/') || !known.has(name)) refusals.push(`lsblk: ${operands[index]}: not a block device`);
  }
  const selected = (name: string, parent: string | null): boolean =>
    wanted.length === 0 || wanted.includes(name) || (!opts.diskOnly && parent !== null && wanted.includes(parent));
  const kept = (major: number): boolean =>
    !majorsExcluded.has(String(major)) && (majorsIncluded === null || majorsIncluded.has(String(major)));
  for (const d of profile.storage) {
    if (kept(maj)) {
      if (selected(d.name, null)) rows.push(diskRow(d, opts, maj, 0));
      if (!opts.diskOnly) {
        for (let i = 0; i < d.partitions.length; i++) {
          if (selected(d.partitions[i].name, d.name)) rows.push(partitionRow(d.partitions[i], opts, maj, i + 1, listLike || !selected(d.name, null)));
        }
      }
    }
    maj += 16;
  }
  if (wanted.length === 0 && kept(7)) rows.push(loopRow());
  if (opts.all && wanted.length === 0 && kept(11)) rows.push(romRow());
  if (opts.sortColumn !== null) {
    const key = opts.sortColumn;
    const read = COLUMNS.get(key)!;
    rows.sort((x, y) => (key === 'SIZE' ? x.bytes - y.bytes : read(x).localeCompare(read(y), 'en', { numeric: true })));
  }

  if (opts.fs && !opts.columns) opts.columns = ['NAME', 'FSTYPE', 'LABEL', 'UUID', 'MOUNTPOINT'];
  if (opts.topology && !opts.columns) opts.columns = ['NAME', 'ALIGNMENT', 'MIN-IO', 'OPT-IO', 'PHY-SEC', 'LOG-SEC', 'SSZ', 'RA'];
  if (opts.perms && !opts.columns) opts.columns = ['NAME', 'SIZE', 'OWNER', 'GROUP', 'MODE'];

  const columns = opts.columns ?? DEFAULT_COLUMNS;

  const formats = [opts.json, opts.raw, opts.list, opts.pairs].filter(Boolean).length;
  if (formats + (opts.pathPrefix ? 1 : 0) > 2) return { output: `lsblk: invalid combination of options`, exitCode: 1 };

  let body: string;
  if (opts.json) body = renderJson(rows, columns);
  else if (opts.pairs) body = rows.map((r) => columns.map((c) => `${c}="${COLUMNS.get(c)!(r)}"`).join(' ')).join('\n');
  else if (opts.raw) body = renderRaw(rows, columns, opts.noHeadings);
  else body = renderTable(rows, columns, opts.noHeadings);
  if (refusals.length === 0) return { output: body, exitCode: 0 };
  const exitCode = rows.length === 0 ? 32 : 64;
  return { output: [...refusals, ...(rows.length === 0 ? [] : [body])].join('\n'), exitCode };
}

function diskRow(d: StorageDevice, opts: Options, maj: number, min: number): Row {
  return {
    name: opts.pathPrefix ? `/dev/${d.name}` : d.name,
    majMin: `${maj}:${min}`,
    removable: '0',
    size: opts.bytes ? String(d.sizeBytes) : humanSize(d.sizeBytes),
    readOnly: '0',
    type: 'disk',
    mountPoint: '',
    uuid: '',
    fsType: '',
    label: '',
    model: d.model,
    serial: d.serial,
    vendor: d.vendor,
    bytes: d.sizeBytes,
  };
}

function partitionRow(p: DiskPartition, opts: Options, maj: number, min: number, listLike: boolean): Row {
  const prefix = listLike ? '' : '├─';
  return {
    name: opts.pathPrefix ? `/dev/${p.name}` : `${prefix}${p.name}`,
    majMin: `${maj}:${min}`,
    removable: '0',
    size: opts.bytes ? String(p.sizeBytes) : humanSize(p.sizeBytes),
    readOnly: '0',
    type: 'part',
    mountPoint: p.mountPoint,
    uuid: p.uuid || synthUuid(p.name),
    fsType: p.fsType,
    label: p.label,
    model: '',
    serial: '',
    vendor: '',
    bytes: p.sizeBytes,
  };
}

function romRow(): Row {
  return { name: 'sr0', majMin: '11:0', removable: '1', size: '1024M', readOnly: '0', type: 'rom', mountPoint: '', uuid: '', fsType: '', label: '', model: 'QEMU DVD-ROM', serial: '', vendor: 'QEMU', bytes: 1024 * 1024 ** 2 };
}

function loopRow(): Row {
  return { name: 'loop0', majMin: '7:0', removable: '0', size: '0', readOnly: '1', type: 'loop', mountPoint: '', uuid: '', fsType: '', label: '', model: '', serial: '', vendor: '', bytes: 0 };
}

function humanSize(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(0)}G`;
  const mib = bytes / 1024 ** 2;
  return `${mib.toFixed(0)}M`;
}

function synthUuid(seed: string): string {
  let h = 0;
  for (const c of seed) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  const u = (h >>> 0).toString(16).padStart(8, '0');
  return `${u}-${u.slice(0, 4)}-${u.slice(4, 8)}-${u.slice(0, 4)}-${u}${u.slice(0, 4)}`;
}

function renderTable(rows: Row[], columns: string[], noHeadings: boolean): string {
  return renderTableText(rows, columns.map((header) => ({ header, value: COLUMNS.get(header)! })), {
    gap: 1, rule: false, padTrailing: false, header: !noHeadings,
  });
}

function renderRaw(rows: Row[], columns: string[], noHeadings: boolean): string {
  const lines = rows.map(r => columns.map(c => COLUMNS.get(c)!(r).replace(/ /g, '\\x20')).join(' '));
  return (noHeadings ? lines : [columns.join(' '), ...lines]).join('\n');
}

function renderJson(rows: Row[], columns: string[]): string {
  const obj = {
    blockdevices: rows.map(r => {
      const out: Record<string, string> = {};
      for (const c of columns) out[c.toLowerCase()] = COLUMNS.get(c)!(r);
      return out;
    }),
  };
  return JSON.stringify(obj, null, 3);
}

function helpText(): string {
  return [
    'Usage: lsblk [options] [<device> ...]',
    '',
    'List information about block devices.',
    '',
    'Options:',
    ' -a, --all            print all devices',
    ' -b, --bytes          print SIZE in bytes rather than in human readable format',
    ' -d, --nodeps         don\'t print slaves or holders',
    ' -f, --fs             output info about filesystems',
    ' -J, --json           use JSON output format',
    ' -l, --list           use list format output',
    ' -m, --perms          output info about device owner, group and mode',
    ' -o, --output <list>  output columns',
    ' -p, --paths          print complete device path',
    ' -r, --raw            use raw output format',
    ' -t, --topology       output info about topology',
    ' -h, --help           display this help and exit',
    ' -V, --version        output version information and exit',
  ].join('\n');
}

export const lsblkCommand: LinuxCommand = {
  name: 'lsblk',
  ignoresStdin: true,
  needsNetworkContext: true,
  usage: 'lsblk [options] [<device> ...]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    return cmdLsblk(ctx.executor.hardware, args).output;
  },
  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    return Promise.resolve(cmdLsblk(ctx.executor.hardware, args));
  },
};
