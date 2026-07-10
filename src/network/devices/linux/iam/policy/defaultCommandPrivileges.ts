import { CommandPrivilegePolicy, Deny, Satisfy } from './CommandPrivilegePolicy';

// `chage` declares its own privilege requirement on `chageCommand.privilege`
// now that it's a migrated `LinuxCommand` — see `commands/iam/Chage.ts`.
const ACCOUNT_MANAGEMENT = [
  'useradd', 'adduser', 'addgroup', 'usermod', 'userdel', 'deluser',
  'groupadd', 'groupmod', 'groupdel', 'chpasswd', 'faillock',
] as const;

const AUDIT_TOOLS = ['ausearch', 'aureport', 'auditctl', 'logrotate'] as const;

// `iptables`/`ip6tables` declare their own privilege requirement on
// `iptablesCommand.privilege`/`ip6tablesCommand.privilege` now that they're
// migrated `LinuxCommand`s — see `commands/net/Iptables.ts`/`Ip6tables.ts`.
// The `-save`/`-restore` variants stay here: they need stdin (restore) or
// to see a `>` redirect before running (save), neither of which the
// registry dispatch path threads through today.
const FIREWALL_TOOLS = [
  'iptables-save', 'iptables-restore',
  'ip6tables-save', 'ip6tables-restore',
] as const;

const POWER_CONTROL = ['reboot', 'shutdown'] as const;

const FS_MKFS_TOOLS = ['mkfs', 'mkfs.ext4', 'mkfs.xfs', 'mkfs.btrfs'] as const;

const LVM_TOOLS = ['lvdisplay', 'vgdisplay', 'pvdisplay'] as const;

const ADMIN_GROUPS = ['sudo', 'wheel'] as const;

export function createDefaultCommandPrivileges(): CommandPrivilegePolicy {
  return new CommandPrivilegePolicy()
    .declare([
      ...ACCOUNT_MANAGEMENT, ...AUDIT_TOOLS, ...FIREWALL_TOOLS, ...POWER_CONTROL,
      ...FS_MKFS_TOOLS, ...LVM_TOOLS,
    ])
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
    })
    .declare('mount', {
      // Bare `mount` (or `mount -l`) only lists active mounts and needs no
      // privilege on real Linux; only an actual mount operation does.
      appliesWhen: (args) => !(args.length === 0 || (args.length === 1 && args[0] === '-l')),
      deny: Deny.withMessage('mount: only root can do that: Permission denied'),
    })
    .declare('umount', { deny: Deny.withMessage('umount: only root can do that: Permission denied') })
    .declare('ufw', { deny: Deny.withMessage('ERROR: You need to be root to run this script') })
    .declare('lastlog', {
      appliesWhen: (args) => args.some(a => a === '-C' || a === '--clear' || a === '-S' || a === '--set'),
      deny: Deny.withMessage('lastlog: must be root'),
    })
    .declare('dmesg', {
      appliesWhen: (args) => args.some(a =>
        a === '-c' || a === '--read-clear' || a === '-C' || a === '--clear' ||
        a === '-n' || a === '--console-level'),
      deny: Deny.withMessage('dmesg: read kernel buffer failed: Permission denied'),
    });
}
