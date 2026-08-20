import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const MKFS_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-t', aliases: ['--type'], dest: 'fstype', takesArg: true, argName: 'fstype', description: 'Filesystem type to build (when invoked as plain mkfs)' },
  { flag: '-L', aliases: ['--label'], dest: 'label', takesArg: true, argName: 'label', description: 'Set the filesystem label' },
  { flag: '-c', dest: 'check', description: 'Check the device for bad blocks before building the filesystem' },
  { flag: '-q', aliases: ['--quiet'], dest: 'quiet', description: 'Suppress output' },
  { flag: '-v', aliases: ['--verbose'], dest: 'verbose', description: 'Verbose output' },
  { flag: '-F', aliases: ['--force'], dest: 'force', description: 'Force creation even if the device does not look like a block special device' },
];

function makeMkfsCommand(name: string): LinuxCommand {
  return {
    name,
    needsNetworkContext: false,
    usage: `${name} [options] DEVICE`,
    options: MKFS_OPTIONS,
    privilege: { satisfiedBy: Satisfy.root },
    run: (_ctx, args) => `${name} ${args.join(' ')}\nWriting superblocks and filesystem accounting information: done`,
  };
}

export const mkfsCommand = makeMkfsCommand('mkfs');
export const mkfsExt4Command = makeMkfsCommand('mkfs.ext4');
export const mkfsXfsCommand = makeMkfsCommand('mkfs.xfs');
export const mkfsBtrfsCommand = makeMkfsCommand('mkfs.btrfs');
