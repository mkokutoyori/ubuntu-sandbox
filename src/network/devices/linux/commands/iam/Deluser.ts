import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const DELUSER_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '--remove-home', dest: 'removeHome', description: 'Remove the home directory and mail spool' },
  { flag: '--remove-all-files', dest: 'removeAllFiles', description: 'Remove all files owned by the user on the system' },
  { flag: '--backup', dest: 'backup', description: 'Back up files before removing them' },
  { flag: '--system', dest: 'system', description: 'Only remove the account if it is a system account' },
];

export const deluserCommand: LinuxCommand = {
  name: 'deluser',
  needsNetworkContext: false,
  usage: 'deluser [options] LOGIN [GROUP]',
  options: DELUSER_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: (ctx, args) => ctx.executor.handleDeluser(args).output,
  runWithStatus: (ctx, args) => Promise.resolve(ctx.executor.handleDeluser(args)),
};
