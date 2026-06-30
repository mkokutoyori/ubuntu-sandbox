import type { HardwareProfile } from '@/network/devices/host/hardware/HardwareProfile';
import type { StorageDevice, DiskPartition } from '@/network/devices/host/hardware/StorageDevice';

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
  columns: string[] | null;
}

const SHORT_FLAGS = new Set(['a', 'f', 'p', 'b', 'l', 'r', 'J', 'd', 't', 'm', 'o', 'h', 'V', 'P', 'i']);

export function cmdLsblk(profile: HardwareProfile, args: string[]): { output: string; exitCode: number } {
  const opts: Options = {
    all: false, fs: false, pathPrefix: false, bytes: false, list: false,
    raw: false, json: false, diskOnly: false, topology: false, perms: false,
    columns: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help') return { output: helpText(), exitCode: 0 };
    if (a === '--version') return { output: 'lsblk from util-linux 2.37', exitCode: 0 };
    if (a === '-a' || a === '--all') { opts.all = true; continue; }
    if (a === '-f' || a === '--fs') { opts.fs = true; continue; }
    if (a === '-p' || a === '--paths') { opts.pathPrefix = true; continue; }
    if (a === '-b' || a === '--bytes') { opts.bytes = true; continue; }
    if (a === '-l' || a === '--list') { opts.list = true; continue; }
    if (a === '-r' || a === '--raw') { opts.raw = true; continue; }
    if (a === '-J' || a === '--json') { opts.json = true; continue; }
    if (a === '-d' || a === '--nodeps') { opts.diskOnly = true; continue; }
    if (a === '-t' || a === '--topology') { opts.topology = true; continue; }
    if (a === '-m' || a === '--perms') { opts.perms = true; continue; }
    if (a === '-o' || a === '--output') {
      const v = args[++i];
      if (!v) return { output: `lsblk: option requires an argument -- 'o'`, exitCode: 1 };
      const cols = v.toUpperCase().split(',');
      for (const c of cols) {
        if (!COLUMNS.has(c)) return { output: `lsblk: invalid column name: ${c}`, exitCode: 1 };
      }
      opts.columns = cols;
      continue;
    }
    if (a.startsWith('--')) return { output: `lsblk: unrecognized option '${a}'`, exitCode: 1 };
    if (a.startsWith('-')) {
      for (const ch of a.slice(1)) {
        if (!SHORT_FLAGS.has(ch)) return { output: `lsblk: invalid option -- '${ch}'`, exitCode: 1 };
      }
      continue;
    }
  }

  const rows: Row[] = [];
  let maj = 8;
  for (const d of profile.storage) {
    rows.push(diskRow(d, opts, maj, 0));
    if (!opts.diskOnly) {
      for (let i = 0; i < d.partitions.length; i++) {
        rows.push(partitionRow(d.partitions[i], opts, maj, i + 1));
      }
    }
    maj += 16;
  }
  if (opts.all) rows.push(romRow());

  if (opts.fs && !opts.columns) opts.columns = ['NAME', 'FSTYPE', 'LABEL', 'UUID', 'MOUNTPOINT'];
  if (opts.topology && !opts.columns) opts.columns = ['NAME', 'PHY-SEC', 'LOG-SEC'];
  if (opts.perms && !opts.columns) opts.columns = ['NAME', 'SIZE', 'OWNER', 'GROUP', 'MODE'];

  const columns = opts.columns ?? ['NAME', 'MAJ:MIN', 'RM', 'SIZE', 'RO', 'TYPE', 'MOUNTPOINT'];

  if (opts.json) return { output: renderJson(rows, columns), exitCode: 0 };
  if (opts.raw) return { output: renderRaw(rows, columns), exitCode: 0 };

  return { output: renderTable(rows, columns, opts.list), exitCode: 0 };
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
  };
}

function partitionRow(p: DiskPartition, opts: Options, maj: number, min: number): Row {
  return {
    name: opts.pathPrefix ? `/dev/${p.name}` : (`├─${p.name}`),
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
  };
}

function romRow(): Row {
  return { name: 'sr0', majMin: '11:0', removable: '1', size: '1024M', readOnly: '0', type: 'rom', mountPoint: '', uuid: '', fsType: '', label: '', model: 'QEMU DVD-ROM', serial: '', vendor: 'QEMU' };
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

function renderTable(rows: Row[], columns: string[], _list: boolean): string {
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map(r => COLUMNS.get(c)!(r).length)));
  const lines = [columns.map((c, i) => c.padEnd(widths[i])).join(' ')];
  for (const r of rows) {
    lines.push(columns.map((c, i) => COLUMNS.get(c)!(r).padEnd(widths[i])).join(' '));
  }
  return lines.join('\n');
}

function renderRaw(rows: Row[], columns: string[]): string {
  return rows.map(r => columns.map(c => COLUMNS.get(c)!(r)).join(' ')).join('\n');
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
