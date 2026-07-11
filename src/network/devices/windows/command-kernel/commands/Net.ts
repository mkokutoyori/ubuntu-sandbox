import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { AccountDetail, MachineApi } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function formatAccountList(hostname: string, names: readonly string[]): string {
  const lines: string[] = ['', `User accounts for \\\\${hostname}`, '', '-'.repeat(60)];
  for (let i = 0; i < names.length; i += 3) {
    lines.push(names.slice(i, i + 3).map((n) => n.padEnd(24)).join(''));
  }
  lines.push('-'.repeat(60), 'The command completed successfully.');
  return lines.join('\n');
}

function formatAccountDetails(detail: AccountDetail): string {
  const localGroups = detail.localGroups.map((g) => `*${g}`).join('  ');
  const lines: string[] = [
    `User name                    ${detail.name}`,
    `Full Name                    ${detail.fullName}`,
    `Comment                      ${detail.description}`,
    `User's comment`,
    `Country/region code          000 (System Default)`,
    `Account active               ${detail.enabled ? 'Yes' : 'No'}`,
    `Account expires              Never`,
    ``,
    `Password last set            ${detail.passwordLastSet.toLocaleDateString('en-US')}`,
    `Password expires             Never`,
    `Password changeable          ${detail.passwordLastSet.toLocaleDateString('en-US')}`,
    `Password required            ${detail.passwordRequired ? 'Yes' : 'No'}`,
    `User may change password     ${detail.userMayChangePassword ? 'Yes' : 'No'}`,
    ``,
    `Workstations allowed         All`,
    `Logon script`,
    `User profile`,
    `Home directory`,
    `Last logon                   ${detail.lastLogon ? detail.lastLogon.toLocaleDateString('en-US') : 'Never'}`,
    ``,
    `Logon hours allowed          All`,
    ``,
    `Local Group Memberships      ${localGroups || '(none)'}`,
    `Global Group memberships     *None`,
    `The command completed successfully.`,
  ];
  return lines.join('\n');
}

function formatDomainAccountDetails(detail: { sam: string; fullName: string; enabled: boolean; globalGroups: readonly string[] }): string {
  const lines: string[] = [
    `User name                    ${detail.sam}`,
    `Full Name                    ${detail.fullName}`,
    `Comment`,
    `User's comment`,
    `Country/region code          000 (System Default)`,
    `Account active               ${detail.enabled ? 'Yes' : 'No'}`,
    `Account expires              Never`,
    ``,
    `Password expires             Never`,
    ``,
    `Workstations allowed         All`,
    `Logon script`,
    `User profile`,
    `Home directory`,
    `Last logon                   Never`,
    ``,
    `Logon hours allowed          All`,
    ``,
    `Local Group Memberships`,
    `Global Group memberships     ${detail.globalGroups.map((g) => `*${g}`).join('  ') || '*None'}`,
    `The command completed successfully.`,
  ];
  return lines.join('\n');
}

function formatGroupList(hostname: string, names: readonly string[]): string {
  const lines: string[] = ['', `Aliases for \\\\${hostname}`, '', '-'.repeat(60)];
  for (const g of names) lines.push(`*${g}`);
  lines.push('-'.repeat(60), 'The command completed successfully.');
  return lines.join('\n');
}

function formatGroupMembers(detail: { name: string; description: string; members: readonly string[] }): string {
  const lines: string[] = [
    `Alias name     ${detail.name}`,
    `Comment        ${detail.description}`,
    '',
    'Members',
    '',
    '-'.repeat(60),
    ...detail.members,
    '-'.repeat(60),
    'The command completed successfully.',
  ];
  return lines.join('\n');
}

function formatRunningServices(machine: MachineApi): string {
  const names = machine.services!.runningServiceNames()
    .map((n) => machine.services!.displayNameFor(n)!)
    .sort((a, b) => a.localeCompare(b));
  const lines: string[] = ['These Windows services are started:\n'];
  for (const displayName of names) lines.push(`   ${displayName}`);
  lines.push('\nThe command completed successfully.\n');
  return lines.join('\n');
}

function formatShareList(shares: readonly { name: string; path: string; description: string }[]): string {
  const lines: string[] = ['', 'Share name   Resource                        Remark', '', '-'.repeat(79)];
  for (const e of shares) lines.push(`${e.name.padEnd(13)}${e.path.padEnd(32)}${e.description}`);
  lines.push('The command completed successfully.');
  return lines.join('\n');
}

function formatSessionList(sessions: readonly { clientComputerName: string; user: string; numOpens: number }[]): string {
  const header = 'Computer             User name            Client Type       Opens Idle time\n' + '-'.repeat(75) + '\n';
  if (sessions.length === 0) return header + 'There are no entries in the list.';
  const rows = sessions.map((s) =>
    `\\\\${s.clientComputerName}`.padEnd(22) + s.user.padEnd(21) + ''.padEnd(18) + String(s.numOpens).padStart(5) + '  00:00:00');
  return header + rows.join('\n') + '\nThe command completed successfully.';
}

function formatUseList(mappings: readonly { local: string; remote: string; status: string }[]): string {
  const header = 'New connections will be remembered.\n\n\nStatus       Local     Remote                    Network\n' + '-'.repeat(79) + '\n';
  if (mappings.length === 0) return header + 'There are no entries in the list.';
  const rows = mappings.map((e) => `${e.status.padEnd(13)}${e.local.padEnd(10)}${e.remote.padEnd(26)}Microsoft Windows Network`);
  return header + rows.join('\n') + '\nThe command completed successfully.';
}

export class NetCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'net',
    summary: 'Administre comptes, groupes, services et partages réseau',
    usage: 'net <user|localgroup|start|stop|share|session|use|accounts> ...',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'sous-commande net' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  private async handleUser(ctx: CommandContext, args: readonly string[]): Promise<string> {
    const users = ctx.machine.users;
    if (!users.listAccountNames || !users.getAccountDetail || !users.createAccount || !users.deleteAccount || !users.setAccountProperty) {
      return 'NET USER: not supported on this device';
    }
    const domainErr = 'System error 1355 has occurred.\n\nThe specified domain either does not exist or could not be contacted.';

    if (args.length === 0) return formatAccountList(ctx.machine.hostname, users.listAccountNames());

    const flags = new Map<string, string>();
    const positional: string[] = [];
    let domain = false;
    for (const arg of args) {
      const lower = arg.toLowerCase();
      if (lower === '/add') flags.set('add', 'true');
      else if (lower === '/delete') flags.set('delete', 'true');
      else if (lower === '/domain') domain = true;
      else if (lower.startsWith('/active:')) flags.set('active', arg.substring(8));
      else if (lower.startsWith('/fullname:')) flags.set('fullname', stripQuotes(arg.substring(10)));
      else if (lower.startsWith('/comment:')) flags.set('comment', stripQuotes(arg.substring(9)));
      else positional.push(arg);
    }

    if (domain) {
      if (!users.domainAccountNames || !users.getDomainAccountDetail) return domainErr;
      const names = users.domainAccountNames();
      if (names === undefined) return domainErr;
      const username = positional[0];
      if (!username) return formatAccountList(ctx.machine.hostname, names);
      const detail = users.getDomainAccountDetail(username);
      if (!detail) return 'The user name could not be found.\n\nMore help is available by typing NET HELPMSG 2221.';
      return formatDomainAccountDetails(detail);
    }

    const username = positional[0];
    if (!username) return 'The syntax of this command is:\n\nNET USER [username [password | *] [options]] [/DOMAIN]\n         username {password | *} /ADD [options] [/DOMAIN]\n         username [/DELETE] [/DOMAIN]';

    if (flags.has('add')) {
      const password = positional[1] || '';
      const created = users.createAccount(username, password);
      if (!created.ok) return `System error.\n\n${created.error}`;
      ctx.machine.groups.addGroupMember?.('Users', username);
      for (const propKey of ['fullname', 'comment', 'active'] as const) {
        if (flags.has(propKey)) {
          const result = users.setAccountProperty(username, propKey, flags.get(propKey)!);
          if (!result.ok) return `System error.\n\n${result.error}`;
        }
      }
      return 'The command completed successfully.';
    }

    if (flags.has('delete')) {
      const result = users.deleteAccount(username);
      if (!result.ok) return `System error.\n\n${result.error}`;
      return 'The command completed successfully.';
    }

    for (const propKey of ['active', 'fullname', 'comment'] as const) {
      if (flags.has(propKey)) {
        const result = users.setAccountProperty(username, propKey, flags.get(propKey)!);
        if (!result.ok) return `System error.\n\n${result.error}`;
        return 'The command completed successfully.';
      }
    }

    if (positional.length >= 2) {
      const result = users.setAccountProperty(username, 'password', positional[1]);
      if (!result.ok) return `System error.\n\n${result.error}`;
      return 'The command completed successfully.';
    }

    const detail = users.getAccountDetail(username);
    if (!detail) return 'The user name could not be found.\n\nMore help is available by typing NET HELPMSG 2221.';
    return formatAccountDetails(detail);
  }

  private handleLocalgroup(ctx: CommandContext, args: readonly string[]): string {
    const groups = ctx.machine.groups;
    if (!groups.listGroupNames || !groups.getGroupDetail || !groups.createGroup || !groups.deleteGroup || !groups.addGroupMember || !groups.removeGroupMember) {
      return 'NET LOCALGROUP: not supported on this device';
    }
    if (args.length === 0) return formatGroupList(ctx.machine.hostname, groups.listGroupNames());

    const flags = new Map<string, string>();
    const positional: string[] = [];
    for (const arg of args) {
      const lower = arg.toLowerCase();
      if (lower === '/add') flags.set('add', 'true');
      else if (lower === '/delete') flags.set('delete', 'true');
      else if (lower.startsWith('/comment:')) flags.set('comment', stripQuotes(arg.substring(9)));
      else positional.push(arg);
    }

    const groupName = positional[0];
    if (!groupName) return 'The syntax of this command is:\n\nNET LOCALGROUP [groupname [/COMMENT:"text"]] [/DOMAIN]\n               groupname {/ADD [/COMMENT:"text"] | /DELETE} [/DOMAIN]\n               groupname name [...] {/ADD | /DELETE} [/DOMAIN]';
    const memberName = positional[1];

    if (flags.has('add') && memberName) {
      const result = groups.addGroupMember(groupName, memberName);
      if (!result.ok) {
        if (result.error?.includes('was not found')) return 'System error.\n\nThe user name could not be found.';
        if (result.error?.includes('already a member')) return 'System error.\n\nThe specified account name is already a member of the group.';
        return `System error.\n\n${result.error}`;
      }
      return 'The command completed successfully.';
    }
    if (flags.has('add') && !memberName) {
      const result = groups.createGroup(groupName, flags.get('comment') || '');
      if (!result.ok) return `System error.\n\n${result.error}`;
      return 'The command completed successfully.';
    }
    if (flags.has('delete') && memberName) {
      const result = groups.removeGroupMember(groupName, memberName);
      if (!result.ok) return `System error.\n\n${result.error}`;
      return 'The command completed successfully.';
    }
    if (flags.has('delete') && !memberName) {
      const result = groups.deleteGroup(groupName);
      if (!result.ok) return `System error.\n\n${result.error}`;
      return 'The command completed successfully.';
    }

    const detail = groups.getGroupDetail(groupName);
    if (!detail) return 'The specified group could not be found.\n\nMore help is available by typing NET HELPMSG 3711.';
    return formatGroupMembers(detail);
  }

  private handleStart(ctx: CommandContext, args: readonly string[]): string {
    const services = ctx.machine.services;
    if (!services) return 'NET START: not supported on this device';
    if (args.length === 0) return formatRunningServices(ctx.machine);
    const name = services.resolveName(args.join(' '));
    if (!name) return 'The service name is invalid.\n\nMore help is available by typing NET HELPMSG 2185.';
    const result = services.start(name, ctx.session.user.isRoot());
    if (!result.ok) {
      if (result.error?.includes('Access is denied')) return 'System error 5 has occurred.\n\nAccess is denied.';
      if (result.error?.includes('already running')) return 'The requested service has already been started.\n\nMore help is available by typing NET HELPMSG 2182.';
      if (result.error?.includes('disabled')) return 'The service cannot be started, either because it is disabled or because\nit has no enabled devices associated with it.\n\nMore help is available by typing NET HELPMSG 3521.';
      return `System error.\n\n${result.error}`;
    }
    return `The ${services.displayNameFor(name)} service was started successfully.\n`;
  }

  private handleStop(ctx: CommandContext, args: readonly string[]): string {
    const services = ctx.machine.services;
    if (!services) return 'NET STOP: not supported on this device';
    if (args.length === 0) return 'The syntax of this command is:\n\nNET STOP\nservice';
    const name = services.resolveName(args.join(' '));
    if (!name) return 'The service name is invalid.\n\nMore help is available by typing NET HELPMSG 2185.';
    const displayName = services.displayNameFor(name);
    const result = services.stop(name, ctx.session.user.isRoot());
    if (!result.ok) {
      if (result.error?.includes('Access is denied')) return 'System error 5 has occurred.\n\nAccess is denied.';
      if (result.error?.includes('not been started')) return `The ${displayName} service is not started.\n\nMore help is available by typing NET HELPMSG 3521.`;
      if (result.error?.includes('Cannot stop') || result.error?.includes('dependent')) return `The ${displayName} service could not be stopped.\n\n${result.error}`;
      return `System error.\n\n${result.error}`;
    }
    return `The ${displayName} service was stopped successfully.\n`;
  }

  private handleShare(ctx: CommandContext, args: readonly string[]): string {
    const shares = ctx.machine.smbShares;
    if (!shares) return 'NET SHARE: not supported on this device';
    if (!shares.isServerRunning()) return 'The Server service is not started.\n\nMore help is available by typing NET HELPMSG 2138.';
    if (args.length === 0) return formatShareList(shares.list());

    const wantsDelete = args.some((a) => /^\/(delete|d)$/i.test(a));
    if (wantsDelete) {
      const name = args[0];
      const result = shares.remove(name);
      if (!result.ok) return result.error!;
      return `${name} was deleted successfully.`;
    }

    const m = /^([A-Za-z][\w$]*)=(.+)$/.exec(args[0]);
    if (m) {
      const [, name, resource] = m;
      const remarkArg = args.find((a) => a.toLowerCase().startsWith('/remark:'));
      const remark = remarkArg ? remarkArg.slice('/remark:'.length).replace(/^"|"$/g, '') : '';
      const result = shares.add(name, resource, remark);
      if (!result.ok) return result.error!;
      return `${name} was shared successfully.`;
    }

    return 'The syntax of this command is:\n\nNET SHARE\nsharename\nsharename=drive:path [/USERS:number | /UNLIMITED]\n                     [/REMARK:"text"]\nsharename [/USERS:number | /UNLIMITED] [/REMARK:"text"]\n{sharename | devicename | drive:path} /DELETE';
  }

  private handleSession(ctx: CommandContext, args: readonly string[]): string {
    const sessions = ctx.machine.smbSessions;
    if (!sessions) return 'NET SESSION: not supported on this device';
    if (args.some((a) => a.toLowerCase() === '/delete')) {
      const target = args.find((a) => a.startsWith('\\\\'));
      sessions.closeMatching(target?.slice(2));
      return 'The command completed successfully.';
    }
    return formatSessionList(sessions.list());
  }

  private async handleUse(ctx: CommandContext, args: readonly string[]): Promise<string> {
    const netUse = ctx.machine.netUse;
    if (!netUse) return 'NET USE: not supported on this device';
    if (!netUse.isWorkstationRunning()) return 'The Workstation service has not been started.\n\nMore help is available by typing NET HELPMSG 2185.';
    if (args.length === 0) return formatUseList(netUse.list());

    const first = args[0];
    const isDriveLetter = /^[A-Za-z]:$/.test(first);
    const isWildcard = first === '*';

    const wantsDelete = args.some((a) => a.toLowerCase() === '/delete' || a.toLowerCase() === '/d');
    if (wantsDelete) {
      if (isWildcard) {
        const n = netUse.disconnectAll();
        return `${n} connections removed.\nThe command completed successfully.`;
      }
      const removed = netUse.disconnect(first);
      if (!removed) return 'The network connection could not be found.';
      return `${first.toUpperCase()} was deleted successfully.`;
    }

    if (isDriveLetter && args[1]?.startsWith('\\\\')) {
      const userArg = args.find((a) => a.toLowerCase().startsWith('/user:'));
      const username = userArg ? userArg.slice('/user:'.length) : 'Administrator';
      const password = args[2] && !args[2].startsWith('/') ? args[2] : '';
      const result = await netUse.connect(first, args[1], username, password);
      if (!result.ok) return result.error!;
      return 'The command completed successfully.';
    }

    return 'The syntax of this command is:\n\nNET USE\n[devicename | *] [\\\\computername\\sharename[\\volume] [password | *]]\n      [/USER:[domainname\\]username]\n      [/PERSISTENT:{YES | NO} | /DELETE]';
  }

  private handleAccounts(ctx: CommandContext, args: readonly string[]): string {
    const policy = ctx.machine.accountsPolicy;
    if (!policy) return 'NET ACCOUNTS: not supported on this device';
    if (args.length === 0) return policy.render();
    for (const arg of args) {
      const m = /^\/(\w+):(.+)$/.exec(arg);
      if (!m) continue;
      const err = policy.apply(m[1], m[2]);
      if (err) return `System error.\n\n${err}`;
    }
    return 'The command completed successfully.';
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (args.length === 0) {
      await ctx.io.stdout.write('More help is available by typing NET HELP command.\n');
      return 1;
    }
    const subCmd = args[0].toLowerCase();
    const subArgs = args.slice(1);

    let output: string;
    switch (subCmd) {
      case 'user': output = await this.handleUser(ctx, subArgs); break;
      case 'localgroup': output = this.handleLocalgroup(ctx, subArgs); break;
      case 'start': output = this.handleStart(ctx, subArgs); break;
      case 'stop': output = this.handleStop(ctx, subArgs); break;
      case 'share': output = this.handleShare(ctx, subArgs); break;
      case 'session': output = this.handleSession(ctx, subArgs); break;
      case 'use': output = await this.handleUse(ctx, subArgs); break;
      case 'accounts': output = this.handleAccounts(ctx, subArgs); break;
      default: output = 'The command syntax is incorrect.'; break;
    }

    await ctx.io.stdout.write(output + '\n');
    return EXIT_OK;
  }
}
