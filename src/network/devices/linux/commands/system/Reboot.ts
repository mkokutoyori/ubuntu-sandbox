import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const REBOOT_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-f', aliases: ['--force'], dest: 'force', description: 'Force an immediate reboot, without contacting init' },
  { flag: '-p', aliases: ['--poweroff'], dest: 'poweroff', description: 'Power off instead of rebooting' },
  { flag: '-n', aliases: ['--no-sync'], dest: 'noSync', description: 'Do not sync filesystems before rebooting' },
];

export const rebootCommand: LinuxCommand = {
  name: 'reboot',
  aliases: ['shutdown'],
  needsNetworkContext: false,
  usage: 'reboot',
  options: REBOOT_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: (ctx) => {
    ctx.executor.auditRules.rebootReset();
    ctx.executor.iptables.resetAll();
    ctx.executor.ip6tables.resetAll();
    ctx.executor.serviceMgr.rebootCycle();
    return '';
  },
};
