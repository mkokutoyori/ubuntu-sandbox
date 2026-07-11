import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { SecurityIdentity } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

function formatUserInfo(identity: SecurityIdentity): string {
  const lines: string[] = ['', 'USER INFORMATION', '----------------', ''];
  lines.push('User Name' + ' '.repeat(24) + 'SID');
  lines.push('='.repeat(33) + ' ' + '='.repeat(47));
  lines.push(identity.accountName.padEnd(33) + ' ' + identity.sid);
  return lines.join('\n');
}

function formatGroupInfo(identity: SecurityIdentity): string {
  const lines: string[] = ['', 'GROUP INFORMATION', '-----------------', ''];
  lines.push('Group Name'.padEnd(44) + 'Type'.padEnd(14) + 'SID'.padEnd(20) + 'Attributes');
  lines.push('='.repeat(44) + ' ' + '='.repeat(13) + ' ' + '='.repeat(48) + ' ' + '='.repeat(30));
  for (const g of identity.groups) {
    lines.push(g.displayName.padEnd(44) + g.type.padEnd(14) + g.sid.padEnd(49) + g.attributes);
  }
  return lines.join('\n');
}

function formatPrivilegeInfo(identity: SecurityIdentity): string {
  const lines: string[] = ['', 'PRIVILEGES INFORMATION', '----------------------', ''];
  lines.push('Privilege Name'.padEnd(45) + 'Description'.padEnd(50) + 'State');
  lines.push('='.repeat(45) + ' ' + '='.repeat(50) + ' ' + '='.repeat(10));
  for (const p of identity.privileges) {
    lines.push(p.name.padEnd(45) + p.description.padEnd(50) + p.state);
  }
  return lines.join('\n');
}

export class WhoamiCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'whoami',
    summary: "Affiche l'identité de l'utilisateur courant",
    usage: 'whoami [/user|/groups|/priv|/all]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'option whoami' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const flag = args.length > 0 ? args[0].toLowerCase() : '';
    const identity = await ctx.machine.users.securityIdentity?.(ctx.session.user.name);

    if (!flag) {
      await ctx.io.stdout.write((identity?.accountName ?? ctx.session.user.name.toLowerCase()) + '\n');
      return EXIT_OK;
    }

    if (!identity) {
      await ctx.io.stdout.write('WHOAMI: not supported on this device\n');
      return 1;
    }

    switch (flag) {
      case '/user':
        await ctx.io.stdout.write(formatUserInfo(identity) + '\n');
        return EXIT_OK;
      case '/groups':
        await ctx.io.stdout.write(formatGroupInfo(identity) + '\n');
        return EXIT_OK;
      case '/priv':
        await ctx.io.stdout.write(formatPrivilegeInfo(identity) + '\n');
        return EXIT_OK;
      case '/all':
        await ctx.io.stdout.write([
          formatUserInfo(identity), '', formatGroupInfo(identity), '', formatPrivilegeInfo(identity),
        ].join('\n') + '\n');
        return EXIT_OK;
      default:
        await ctx.io.stdout.write(`ERROR: Invalid argument/option - '${args[0]}'.\nType "WHOAMI /?" for usage.\n`);
        return 1;
    }
  }
}
