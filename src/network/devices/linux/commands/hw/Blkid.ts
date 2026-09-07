import type { HardwareProfile } from '@/network/devices/host/hardware/HardwareProfile';
import type { DiskPartition } from '@/network/devices/host/hardware/StorageDevice';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { Satisfy, Deny } from '../../iam/policy/CommandPrivilegePolicy';
import {
  partitionPartUuid, partitionUuid,
} from '@/network/devices/host/hardware/partitionUuid';

export function cmdBlkid(profile: HardwareProfile, args: string[], isPrivileged: boolean): { output: string; exitCode: number } {
  if (!isPrivileged) return { output: 'blkid: error: Permission denied', exitCode: 1 };
  const targets: string[] = [];
  for (const a of args) {
    if (a === '-h' || a === '--help') return { output: helpText(), exitCode: 0 };
    if (a === '-V' || a === '--version') return { output: 'blkid from util-linux 2.37', exitCode: 0 };
    if (a.startsWith('-')) return { output: `blkid: unrecognized option '${a}'`, exitCode: 1 };
    targets.push(a);
  }

  const all: Array<{ disk: string; part: DiskPartition }> = [];
  for (const d of profile.storage) for (const p of d.partitions) all.push({ disk: d.name, part: p });

  const matches = targets.length === 0
    ? all
    : all.filter(e => targets.includes(`/dev/${e.part.name}`));

  if (targets.length > 0 && matches.length === 0) {
    return { output: `blkid: error: ${targets[0]}: No such file or directory`, exitCode: 2 };
  }

  const lines = matches.map(e =>
    `/dev/${e.part.name}: UUID="${partitionUuid(e.part)}"`
    + ` TYPE="${e.part.fsType}" PARTUUID="${partitionPartUuid(e.part)}"`);
  return { output: lines.join('\n'), exitCode: 0 };
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
    return cmdBlkid(ctx.executor.hardware, args, isPrivileged(ctx)).output;
  },
  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    return Promise.resolve(cmdBlkid(ctx.executor.hardware, args, isPrivileged(ctx)));
  },
};
