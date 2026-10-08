import type { LinuxCommand } from '../LinuxCommand';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

export const augenrulesCommand: LinuxCommand = {
  name: 'augenrules',
  needsNetworkContext: false,
  usage: 'augenrules [--check|--load]',
  options: [
    { flag: '--check', dest: 'check', description: 'Only report whether the compiled rules are out of date' },
    { flag: '--load', dest: 'load', description: 'Load the compiled rules into the kernel' },
  ],
  privilege: { satisfiedBy: Satisfy.root },
  run: (ctx, args) => ctx.executor.handleAugenrules(args).output,
  runWithStatus: (ctx, args) => Promise.resolve(ctx.executor.handleAugenrules(args)),
};
