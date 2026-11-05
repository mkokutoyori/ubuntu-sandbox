import type { DiskPartition } from '@/network/devices/host/hardware/StorageDevice';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { Satisfy, Deny } from '../../iam/policy/CommandPrivilegePolicy';
import { getoptDiagnostic, shortOptions, type LongOption } from '../Getopt';
import { readSwapSignature } from '../system/SwapSignature';
import {
  partitionPartUuid, partitionUuid,
} from '@/network/devices/host/hardware/partitionUuid';

const SHORT = 'c:d:ghilL:n:o:O:ps:S:t:u:U:w:vV';

const LONG: readonly LongOption[] = [
  { name: 'cache-file', letter: 'c', takesArgument: true },
  { name: 'no-encoding', letter: 'd', takesArgument: false },
  { name: 'garbage-collect', letter: 'g', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'info', letter: 'i', takesArgument: false },
  { name: 'list-one', letter: 'l', takesArgument: false },
  { name: 'label', letter: 'L', takesArgument: true },
  { name: 'match-types', letter: 'n', takesArgument: true },
  { name: 'output', letter: 'o', takesArgument: true },
  { name: 'offset', letter: 'O', takesArgument: true },
  { name: 'probe', letter: 'p', takesArgument: false },
  { name: 'match-tag', letter: 's', takesArgument: true },
  { name: 'size', letter: 'S', takesArgument: true },
  { name: 'match-token', letter: 't', takesArgument: true },
  { name: 'usages', letter: 'u', takesArgument: true },
  { name: 'uuid', letter: 'U', takesArgument: true },
  { name: 'wipe-cache', letter: 'w', takesArgument: true },
  { name: 'version', letter: 'V', takesArgument: false },
];

const TAG_ORDER = ['LABEL', 'UUID', 'TYPE', 'PARTUUID'];
const FORMATS = ['full', 'value', 'list', 'device', 'udev', 'export'];

interface Probed {
  readonly device: string;
  readonly tags: ReadonlyArray<readonly [string, string]>;
  readonly mountPoint: string;
}

type Outcome = { output: string; exitCode: number };

function partitionTags(part: DiskPartition): Array<readonly [string, string]> {
  const tags: Array<readonly [string, string]> = [];
  if (part.label) tags.push(['LABEL', part.label]);
  tags.push(['UUID', partitionUuid(part)], ['TYPE', part.fsType], ['PARTUUID', partitionPartUuid(part)]);
  return tags;
}

function sortedTags(tags: ReadonlyArray<readonly [string, string]>): Array<readonly [string, string]> {
  return [...tags].sort((x, y) => TAG_ORDER.indexOf(x[0]) - TAG_ORDER.indexOf(y[0]));
}

function hardwareDevices(ctx: LinuxCommandContext): Probed[] {
  const found: Probed[] = [];
  for (const disk of ctx.executor.hardware.storage) {
    for (const part of disk.partitions) {
      found.push({ device: `/dev/${part.name}`, tags: partitionTags(part), mountPoint: part.mountPoint });
    }
  }
  return found;
}

function swapFileDevice(ctx: LinuxCommandContext, operand: string): Probed | null {
  const abs = ctx.executor.vfs.normalizePath(operand, ctx.executor.getCwd());
  const inode = ctx.executor.vfs.resolveInode(abs);
  if (!inode || inode.type !== 'file') return null;
  const signature = readSwapSignature(inode.content);
  if (!signature) return null;
  const tags: Array<readonly [string, string]> = [];
  if (signature.label) tags.push(['LABEL', signature.label]);
  tags.push(['UUID', signature.uuid], ['TYPE', 'swap']);
  return { device: operand, tags, mountPoint: '' };
}

function render(devices: readonly Probed[], format: string, wanted: readonly string[]): string {
  const visible = (device: Probed): Array<readonly [string, string]> =>
    sortedTags(device.tags).filter(([name]) => wanted.length === 0 || wanted.includes(name));
  switch (format) {
    case 'value': return devices.flatMap((d) => visible(d).map(([, value]) => value)).join('\n');
    case 'device': return devices.map((d) => d.device).join('\n');
    case 'export': return devices.map((d) => [`DEVNAME=${d.device}`, ...visible(d).map(([k, v]) => `${k}=${v}`)].join('\n')).join('\n\n');
    case 'udev': return devices.map((d) => visible(d).flatMap(([k, v]) => {
      if (k === 'LABEL') return [`ID_FS_LABEL=${v}`, `ID_FS_LABEL_ENC=${v}`];
      if (k === 'UUID') return [`ID_FS_UUID=${v}`, `ID_FS_UUID_ENC=${v}`];
      if (k === 'TYPE') return [`ID_FS_TYPE=${v}`];
      return [];
    }).join('\n')).join('\n');
    case 'list': {
      const rows = devices.map((d) => {
        const tag = (name: string): string => d.tags.find(([k]) => k === name)?.[1] ?? '';
        return [d.device, tag('TYPE'), tag('LABEL'), d.mountPoint === '' ? '(not mounted)' : d.mountPoint, tag('UUID')];
      });
      const headers = ['device', 'fs_type', 'label', 'mount point', 'UUID'];
      const minimum = [headers[0].length, 7, 8, 14, 0];
      const widths = headers.map((_, i) => Math.max(minimum[i], ...rows.map((r) => r[i].length)));
      const line = (cells: readonly string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join(' ');
      return [line(headers), '', ...rows.map(line)].join('\n');
    }
    default: return devices.map((d) => `${d.device}: ${visible(d).map(([k, v]) => `${k}="${v}"`).join(' ')}`).join('\n');
  }
}

export function cmdBlkid(ctx: LinuxCommandContext, args: string[], isPrivileged: boolean): Outcome {
  if (!isPrivileged) return { output: 'blkid: error: Permission denied', exitCode: 1 };
  const operands: string[] = [];
  const wanted: string[] = [];
  let format = 'full';
  let token: string | undefined;
  let byLabel: string | undefined;
  let byUuid: string | undefined;
  for (const item of shortOptions(args, SHORT, LONG)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return { output: `${getoptDiagnostic('blkid', item)}\nTry 'blkid --help' for more information.`, exitCode: 1 };
    switch (item.letter) {
      case 'h': return { output: helpText(), exitCode: 0 };
      case 'V': return { output: 'blkid from util-linux 2.37', exitCode: 0 };
      case 'o': format = item.argument ?? ''; break;
      case 's': wanted.push((item.argument ?? '').toUpperCase()); break;
      case 't': token = item.argument ?? ''; break;
      case 'L': byLabel = item.argument ?? ''; break;
      case 'U': byUuid = item.argument ?? ''; break;
      default: break;
    }
  }
  if (!FORMATS.includes(format)) return { output: `blkid: unsupported output format ${format}`, exitCode: 4 };
  let wantedPair: [string, string] | undefined;
  if (token !== undefined) {
    const eq = token.indexOf('=');
    if (eq < 1) return { output: "blkid: -t needs NAME=value pair\nTry 'blkid --help' for more information.", exitCode: 4 };
    wantedPair = [token.slice(0, eq).toUpperCase(), token.slice(eq + 1).replace(/^"(.*)"$/, '$1')];
  }

  const known = hardwareDevices(ctx);
  let devices: Probed[];
  if (operands.length === 0) {
    devices = known;
  } else {
    devices = [];
    for (const operand of operands) {
      const hardware = known.find((d) => d.device === operand);
      const probed = hardware ?? swapFileDevice(ctx, operand);
      if (probed) devices.push(probed);
    }
  }

  if (byLabel !== undefined || byUuid !== undefined) {
    const [name, value] = byLabel !== undefined ? ['LABEL', byLabel] : ['UUID', byUuid ?? ''];
    const pool = [...known, ...ctx.executor.hardware.memory.swapAreas.flatMap((area) => swapFileDevice(ctx, area.path) ?? [])];
    const hit = pool.find((d) => d.tags.some(([k, v]) => k === name && v === value));
    return hit ? { output: hit.device, exitCode: 0 } : { output: '', exitCode: 2 };
  }
  if (wantedPair) {
    const [name, value] = wantedPair;
    devices = devices.filter((d) => d.tags.some(([k, v]) => k === name && v === value));
  }
  if (devices.length === 0) return { output: '', exitCode: 2 };
  return { output: render(devices, format, wanted), exitCode: 0 };
}

function helpText(): string {
  return [
    'Usage:',
    ' blkid -L <label> | -U <uuid>',
    ' blkid [-o <format>] [-s <tag>] [--match-token <NAME=value>] [--match-tag <tag>]',
    '       [<dev> ...]',
  ].join('\n');
}

function isPrivileged(ctx: LinuxCommandContext): boolean {
  return ctx.executor.userMgr.currentUser === 'root';
}

export const blkidCommand: LinuxCommand = {
  name: 'blkid',
  needsNetworkContext: true,
  usage: 'blkid [options] [<dev> ...]',
  privilege: {
    satisfiedBy: Satisfy.root,
    deny: Deny.withMessage('blkid: error: Permission denied'),
  },
  run(ctx: LinuxCommandContext, args: string[]): string {
    return cmdBlkid(ctx, args, isPrivileged(ctx)).output;
  },
  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    return Promise.resolve(cmdBlkid(ctx, args, isPrivileged(ctx)));
  },
};
