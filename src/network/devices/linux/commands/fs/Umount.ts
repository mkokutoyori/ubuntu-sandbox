import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Deny } from '../../iam/policy/CommandPrivilegePolicy';

const UMOUNT_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-l', aliases: ['--lazy'], dest: 'lazy', description: 'Detach the filesystem now, clean up references later' },
  { flag: '-f', aliases: ['--force'], dest: 'force', description: 'Force unmount (for an unreachable filesystem)' },
  { flag: '-a', aliases: ['--all'], dest: 'all', description: 'Unmount every mounted filesystem' },
  { flag: '-t', aliases: ['--types'], dest: 'fstype', takesArg: true, argName: 'fstype', description: 'Restrict to filesystems of this type' },
  { flag: '-R', aliases: ['--recursive'], dest: 'recursive', description: 'Recursively unmount each submount under the given directory' },
  { flag: '-v', aliases: ['--verbose'], dest: 'verbose', description: 'Verbose output' },
];

export const umountCommand: LinuxCommand = {
  name: 'umount',
  needsNetworkContext: false,
  usage: 'umount MOUNTPOINT',
  options: UMOUNT_OPTIONS,
  privilege: { deny: Deny.withMessage('umount: only root can do that: Permission denied') },
  run: (ctx, args) => ctx.executor.handleUmount(args).output,
  runWithStatus: (ctx, args) => Promise.resolve(ctx.executor.handleUmount(args)),
};
