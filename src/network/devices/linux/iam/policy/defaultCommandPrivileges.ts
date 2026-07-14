import { CommandPrivilegePolicy, Deny, Satisfy } from './CommandPrivilegePolicy';

/**
 * By-name privilege fallback, consulted by `LinuxCommandExecutor.dispatch()`
 * when no wrapping `LinuxMachine` has registered a `LinuxCommand` with its
 * own `.privilege` for this command (e.g. a bare `LinuxCommandExecutor`
 * constructed directly in a unit test, with no registry at all).
 *
 * `LinuxCommandExecutor` must never import from `commands/` — commands
 * depend on the executor (via `ctx.executor`), so the executor importing
 * commands back would be circular. That means these specs are declared
 * here independently of the matching `LinuxCommand.privilege` in
 * `commands/iam/`, `commands/audit/`, `commands/fs/`, `commands/system/`:
 * both describe the same real-world rule, kept in sync by hand rather than
 * by a shared reference.
 */
const ACCOUNT_MANAGEMENT = [
  'useradd', 'adduser', 'addgroup', 'usermod', 'userdel', 'deluser',
  'groupadd', 'groupmod', 'groupdel', 'chpasswd', 'faillock',
] as const;

const AUDIT_TOOLS = ['ausearch', 'aureport', 'auditctl', 'logrotate'] as const;

// `chage`/`iptables`/`ip6tables` are dispatched purely through the
// LinuxCommand registry (see `commands/iam/Chage.ts`, `commands/net/`);
// a bare executor without a wrapping LinuxMachine cannot run them at all,
// so there is nothing to declare here for them. The `-save`/`-restore`
// variants below stay by-name because they need stdin (restore) or to see
// a `>` redirect (save), neither of which the registry dispatch threads
// through today.
const FIREWALL_SAVE_RESTORE_TOOLS = [
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
      ...ACCOUNT_MANAGEMENT, ...AUDIT_TOOLS, ...FIREWALL_SAVE_RESTORE_TOOLS, ...POWER_CONTROL,
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
    });
}
