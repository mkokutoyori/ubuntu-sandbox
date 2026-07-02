import { CommandPrivilegePolicy, Deny, Satisfy } from './CommandPrivilegePolicy';

const ACCOUNT_MANAGEMENT = [
  'useradd', 'adduser', 'addgroup', 'usermod', 'userdel', 'deluser',
  'groupadd', 'groupmod', 'groupdel', 'chpasswd', 'chage', 'faillock',
] as const;

const AUDIT_TOOLS = ['ausearch', 'aureport', 'auditctl', 'logrotate'] as const;

const FIREWALL_TOOLS = ['iptables', 'iptables-save', 'iptables-restore'] as const;

const POWER_CONTROL = ['reboot', 'shutdown'] as const;

const ADMIN_GROUPS = ['sudo', 'wheel'] as const;

export function createDefaultCommandPrivileges(): CommandPrivilegePolicy {
  return new CommandPrivilegePolicy()
    .declare([...ACCOUNT_MANAGEMENT, ...AUDIT_TOOLS, ...FIREWALL_TOOLS, ...POWER_CONTROL])
    .declare(['chown', 'chgrp'], {
      satisfiedBy: Satisfy.rootOrGroup(...ADMIN_GROUPS),
      deny: Deny.operationNotPermitted,
    })
    .declare('passwd', {
      appliesWhen: (args) => args.length > 0 && !args[0].startsWith('-'),
      deny: (_command, args) => ({
        output: `passwd: You may not view or modify password information for ${args[0]}.`,
        exitCode: 1,
      }),
    })
    .declare('crontab', {
      appliesWhen: (args, actor) => {
        const flag = args.indexOf('-u');
        return flag >= 0 && (args[flag + 1] ?? '') !== actor.user;
      },
      deny: Deny.withMessage('crontab: must be privileged to use -u'),
    });
}
