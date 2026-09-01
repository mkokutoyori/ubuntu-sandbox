import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { Deny } from '../../iam/policy/CommandPrivilegePolicy';

const UFW_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: 'enable', dest: 'enable', description: 'Enable the firewall and load rules at boot' },
  { flag: 'disable', dest: 'disable', description: 'Disable the firewall' },
  { flag: 'status', dest: 'status', description: 'Show the firewall status (add "verbose" or "numbered")' },
  { flag: 'default', dest: 'default', takesArg: true, argName: 'allow|deny|reject <chain>', description: 'Set the default policy for a chain' },
  { flag: 'allow', dest: 'allow', takesArg: true, argName: 'rule', description: 'Add an allow rule' },
  { flag: 'deny', dest: 'deny', takesArg: true, argName: 'rule', description: 'Add a deny rule' },
  { flag: 'reject', dest: 'reject', takesArg: true, argName: 'rule', description: 'Add a reject rule' },
  { flag: 'limit', dest: 'limit', takesArg: true, argName: 'rule', description: 'Add a rate-limiting rule' },
  { flag: 'route', dest: 'route', takesArg: true, argName: 'rule', description: 'Add a routed/forward rule' },
  { flag: 'delete', dest: 'delete', takesArg: true, argName: 'rule|NUM', description: 'Delete a rule by specification or number' },
  { flag: 'insert', dest: 'insert', takesArg: true, argName: 'NUM rule', description: 'Insert a rule at a specific position' },
  { flag: 'prepend', dest: 'prepend', takesArg: true, argName: 'rule', description: 'Prepend a rule before user rules' },
  { flag: 'reset', dest: 'reset', description: 'Disable and reset the firewall to installation defaults' },
  { flag: 'reload', dest: 'reload', description: 'Reload the firewall rules' },
  { flag: 'logging', dest: 'logging', takesArg: true, argName: 'on|off|low|medium|high|full', description: 'Set logging level' },
  { flag: 'app', dest: 'app', takesArg: true, argName: 'list|info|update|default', description: 'Application profile management' },
  { flag: 'show', dest: 'show', takesArg: true, argName: 'raw|listening|added|builtins', description: 'Show extended firewall state' },
  { flag: 'version', dest: 'version', description: 'Display version' },
];

function run(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
  const out = ctx.executor.firewall.execute(args);
  // PRD-Iptables-UFW.md Phase 5 (objectif A.1): `ufw enable`/`disable`
  // drive `systemctl status ufw` too, so it reflects real firewall state.
  if (!out.startsWith('ERROR')) {
    if (args[0] === 'enable') ctx.executor.serviceMgr.start('ufw');
    else if (args[0] === 'disable') ctx.executor.serviceMgr.stop('ufw');
  }
  return { output: out, exitCode: out.startsWith('ERROR') ? 1 : 0 };
}

export const ufwCommand: LinuxCommand = {
  name: 'ufw',
  package: 'ufw',
  needsNetworkContext: false,
  usage: 'ufw COMMAND',
  options: UFW_OPTIONS,
  privilege: { deny: Deny.withMessage('ERROR: You need to be root to run this script') },
  run: (ctx, args) => run(ctx, args).output,
  runWithStatus: (ctx, args) => Promise.resolve(run(ctx, args)),
};
