import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const fail2banClientCommand: LinuxCommand = {
  name: 'fail2ban-client',
  package: 'fail2ban',
  needsNetworkContext: true,
  usage: 'fail2ban-client [status [JAIL] | set JAIL unbanip IP | get JAIL bantime | version | ping]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    const sshCtx = ctx.executor.sshContextForFail2ban?.();
    if (!sshCtx) return 'ERROR  NOK: ("sshd",)';

    if (args[0] === 'status' && args[1] === 'sshd') {
      const banned = sshCtx.bannedIps();
      const totalFailed = sshCtx.totalAuthFailures();
      return [
        'Status for the jail: sshd',
        '|- Filter',
        `|  |- Currently failed: ${banned.length === 0 ? totalFailed : 0}`,
        `|  |- Total failed:     ${totalFailed}`,
        '|  `- File list:        /var/log/auth.log',
        '`- Actions',
        `   |- Currently banned: ${banned.length}`,
        `   |- Total banned:     ${banned.length}`,
        `   \`- Banned IP list:   ${banned.join(' ')}`,
      ].join('\n');
    }
    if (args[0] === 'status') {
      return 'Status\n|- Number of jail:\t1\n`- Jail list:\tsshd';
    }
    if (args[0] === 'set' && args[1] === 'sshd' && args[2] === 'unbanip' && args[3]) {
      const ip = args[3];
      return sshCtx.unbanIp(ip) ? ip : `NOK: ('${ip}',)`;
    }
    if (args[0] === 'get' && args[1] === 'sshd' && args[2] === 'bantime') {
      return String(sshCtx.bantimeSeconds());
    }
    if (args[0] === 'version') return '1.0.2';
    if (args[0] === 'ping') return 'Server replied: pong';
    return 'Usage: fail2ban-client [OPTIONS] <COMMAND>';
  },
};
