import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const LVDISPLAY_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-c', aliases: ['--colon'], dest: 'colon', description: 'Generate colon-separated output' },
  { flag: '-v', aliases: ['--verbose'], dest: 'verbose', description: 'Verbose output' },
  { flag: '--units', dest: 'units', takesArg: true, argName: 'unit', description: 'Display sizes in the given unit' },
  { flag: '-a', aliases: ['--all'], dest: 'all', description: 'Include internal volumes in the output' },
];

export const lvdisplayCommand: LinuxCommand = {
  name: 'lvdisplay',
  aliases: ['vgdisplay', 'pvdisplay'],
  needsNetworkContext: false,
  usage: 'lvdisplay [options]',
  options: LVDISPLAY_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: () => '  No volume groups found',
};
