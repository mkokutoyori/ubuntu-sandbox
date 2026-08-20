import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Deny } from '../../iam/policy/CommandPrivilegePolicy';

const MOUNT_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-o', aliases: ['--options'], dest: 'options', takesArg: true, argName: 'opt1,opt2,...', description: 'Comma-separated mount options' },
  { flag: '-t', aliases: ['--types'], dest: 'fstype', takesArg: true, argName: 'fstype', description: 'Filesystem type' },
  { flag: '-B', aliases: ['--bind'], dest: 'bind', description: 'Bind-mount a directory at another location' },
  { flag: '-R', aliases: ['--rbind'], dest: 'rbind', description: 'Recursively bind-mount a directory tree' },
  { flag: '-r', aliases: ['--read-only'], dest: 'readOnly', description: 'Mount the filesystem read-only' },
  { flag: '-w', aliases: ['--rw'], dest: 'readWrite', description: 'Mount the filesystem read/write (default)' },
  { flag: '-a', aliases: ['--all'], dest: 'mountAll', description: 'Mount every filesystem listed in /etc/fstab' },
  { flag: '-l', dest: 'listLabels', description: 'List active mounts (with -l, also show filesystem labels)' },
  { flag: '-v', aliases: ['--verbose'], dest: 'verbose', description: 'Verbose output' },
  { flag: '-n', aliases: ['--no-mtab'], dest: 'noMtab', description: 'Do not write to /etc/mtab' },
];

export const mountCommand: LinuxCommand = {
  name: 'mount',
  needsNetworkContext: false,
  usage: 'mount [-t type] [-o options] DEVICE MOUNTPOINT',
  options: MOUNT_OPTIONS,
  privilege: {
    // Bare `mount` (or `mount -l`) only lists active mounts and needs no
    // privilege on real Linux; only an actual mount operation does.
    appliesWhen: (args) => !(args.length === 0 || (args.length === 1 && args[0] === '-l')),
    deny: Deny.withMessage('mount: only root can do that: Permission denied'),
  },
  run: (ctx, args) => ctx.executor.handleMount(args).output,
  runWithStatus: (ctx, args) => Promise.resolve(ctx.executor.handleMount(args)),
};
