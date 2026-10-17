/**
 * Windows net user / net localgroup commands.
 *
 * Implements the full `net user` and `net localgroup` command set:
 *   - net user                        → list all users
 *   - net user <name>                 → view user details
 *   - net user <name> <pw> /add       → create user
 *   - net user <name> /delete         → delete user
 *   - net user <name> /active:yes|no  → enable/disable
 *   - net user <name> /fullname:"x"   → set full name
 *   - net user <name> /comment:"x"    → set comment
 *   - net user <name> <pw>            → change password
 *   - net localgroup                  → list all groups
 *   - net localgroup <name>           → view group members
 *   - net localgroup <name> /add      → create group
 *   - net localgroup <name> /delete   → delete group
 *   - net localgroup <name> <user> /add    → add member
 *   - net localgroup <name> <user> /delete → remove member
 */

import { ZonedDate } from '@/network/core/time/ZonedDate';
import { formatDotNetDate } from '@/powershell/runtime/dotnetDateFormat';
import { describeCountryCode, type WindowsUserManager } from './WindowsUserManager';
import { describeLogonHours } from './WindowsLogonHours';
import type { DirectoryStore } from './server/ad/DirectoryStore';

const ACCESS_DENIED = 'System error 5 has occurred.\n\nAccess is denied.';

const NET_MESSAGE_CODES: ReadonlyMap<string, number> = new Map([
  ['The user name could not be found.', 2221],
  ['The account already exists.', 2224],
  ['The user name or group name parameter is invalid.', 2202],
  ['The password of this user cannot be changed.', 2243],
  ['The password of this user is too recent to change.', 2246],
  ['The specified network password is not correct.', 86],
  ['The command syntax is invalid.', 3500],
]);

function netError(message: string): string {
  if (message === 'Access is denied.') return ACCESS_DENIED;
  const code = NET_MESSAGE_CODES.get(message);
  if (code !== undefined) return `${message}\n\nMore help is available by typing NET HELPMSG ${code}.`;
  return `System error.\n\n${message}`;
}

const USER_OPTIONS = [
  'active', 'comment', 'countrycode', 'expires', 'fullname', 'homedir', 'passwordchg',
  'passwordreq', 'profilepath', 'scriptpath', 'times', 'usercomment', 'workstations',
] as const;

type UserOption = typeof USER_OPTIONS[number];

function resolveOption(switchName: string): UserOption | null {
  const lower = switchName.toLowerCase();
  const exact = USER_OPTIONS.find((option) => option === lower);
  if (exact !== undefined) return exact;
  const matches = USER_OPTIONS.filter((option) => option.startsWith(lower));
  return lower !== '' && matches.length === 1 ? matches[0] : null;
}

export interface NetUserContext {
  hostname: string;
  userManager: WindowsUserManager;
  timezone?: string;
  /** Non-null only on a promoted DC (`Install-ADDSForest` succeeded) — backs `net user /domain` (PRD-Windows-Server.md §5 P5). */
  directoryStore?: DirectoryStore | null;
}

// ─── net user ─────────────────────────────────────────────────────

export function cmdNetUser(ctx: NetUserContext, args: string[]): string {
  const domainErr = 'System error 1355 has occurred.\n\nThe specified domain either does not exist or could not be contacted.';

  if (args.length === 0) {
    return formatUserList(ctx);
  }

  const flags = new Map<string, string>();
  const options: Array<[UserOption, string]> = [];
  const positional: string[] = [];
  let domain = false;

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === '/add') flags.set('add', 'true');
    else if (lower === '/delete') flags.set('delete', 'true');
    else if (lower === '/domain') domain = true;
    else if (arg.startsWith('/')) {
      const colon = arg.indexOf(':');
      const option = resolveOption(colon === -1 ? arg.slice(1) : arg.slice(1, colon));
      if (option === null || colon === -1) return netError('The command syntax is invalid.');
      options.push([option, stripQuotes(arg.slice(colon + 1))]);
    } else {
      positional.push(arg);
    }
  }

  // `net user [name] /domain` — real AD DS scope: view/list only (creation and
  // deletion of domain accounts go through the modern New-ADUser/Remove-ADUser
  // cmdlets, which is the real-world convention this simulator mirrors).
  if (domain) {
    if (!ctx.directoryStore) return domainErr;
    const username = positional[0];
    return username ? formatDomainUserDetails(ctx.directoryStore, username) : formatDomainUserList(ctx.directoryStore, ctx.hostname);
  }

  const username = positional[0];
  if (!username) return 'The syntax of this command is:\n\nNET USER [username [password | *] [options]] [/DOMAIN]\n         username {password | *} /ADD [options] [/DOMAIN]\n         username [/DELETE] [/DOMAIN]';

  const applyOptions = (): string => {
    for (const [option, value] of options) {
      const failure = ctx.userManager.setUserProperty(username, option, value);
      if (failure) return netError(failure);
    }
    return '';
  };

  if (flags.has('add')) {
    for (const [option, value] of options) {
      const invalid = ctx.userManager.validateUserOption(option, value);
      if (invalid) return netError(invalid);
    }
    const failure = ctx.userManager.createUser(username, positional[1] || '');
    if (failure) return netError(failure);
    ctx.userManager.addGroupMember('Users', username);
    const optionFailure = applyOptions();
    if (optionFailure) return optionFailure;
    return 'The command completed successfully.';
  }

  if (flags.has('delete')) {
    if (!ctx.userManager.isCurrentUserAdmin()) return ACCESS_DENIED;
    const failure = ctx.userManager.deleteUser(username);
    if (failure) return netError(failure);
    return 'The command completed successfully.';
  }

  if (options.length > 0 || positional.length >= 2) {
    const optionFailure = applyOptions();
    if (optionFailure) return optionFailure;
    if (positional.length >= 2) {
      const failure = ctx.userManager.setUserProperty(username, 'password', positional[1]);
      if (failure) return netError(failure);
    }
    return 'The command completed successfully.';
  }

  return formatUserDetails(ctx, username);
}

// ─── net localgroup ────────────────────────────────────────────────

export function cmdNetLocalgroup(ctx: NetUserContext, args: string[]): string {
  if (args.length === 0) {
    return formatGroupList(ctx);
  }

  const flags = new Map<string, string>();
  const positional: string[] = [];

  for (const arg of args) {
    if (arg.toLowerCase() === '/add') flags.set('add', 'true');
    else if (arg.toLowerCase() === '/delete') flags.set('delete', 'true');
    else if (arg.toLowerCase().startsWith('/comment:')) flags.set('comment', stripQuotes(arg.substring(9)));
    else positional.push(arg);
  }

  const groupName = positional[0];
  if (!groupName) return 'The syntax of this command is:\n\nNET LOCALGROUP [groupname [/COMMENT:"text"]] [/DOMAIN]\n               groupname {/ADD [/COMMENT:"text"] | /DELETE} [/DOMAIN]\n               groupname name [...] {/ADD | /DELETE} [/DOMAIN]';

  const memberName = positional[1];

  // net localgroup <name> <member> /add
  if (flags.has('add') && memberName) {
    if (!ctx.userManager.isCurrentUserAdmin()) return ACCESS_DENIED;
    const err = ctx.userManager.addGroupMember(groupName, memberName);
    if (err) {
      if (err.includes('was not found')) return `System error.\n\nThe user name could not be found.`;
      if (err.includes('already a member')) return `System error.\n\nThe specified account name is already a member of the group.`;
      return netError(err);
    }
    return 'The command completed successfully.';
  }

  // net localgroup <name> /add (create group)
  if (flags.has('add') && !memberName) {
    if (!ctx.userManager.isCurrentUserAdmin()) return ACCESS_DENIED;
    const desc = flags.get('comment') || '';
    const err = ctx.userManager.createGroup(groupName, desc);
    if (err) return netError(err);
    return 'The command completed successfully.';
  }

  // net localgroup <name> <member> /delete
  if (flags.has('delete') && memberName) {
    if (!ctx.userManager.isCurrentUserAdmin()) return ACCESS_DENIED;
    const err = ctx.userManager.removeGroupMember(groupName, memberName);
    if (err) return netError(err);
    return 'The command completed successfully.';
  }

  // net localgroup <name> /delete (delete group)
  if (flags.has('delete') && !memberName) {
    if (!ctx.userManager.isCurrentUserAdmin()) return ACCESS_DENIED;
    const err = ctx.userManager.deleteGroup(groupName);
    if (err) return netError(err);
    return 'The command completed successfully.';
  }

  // net localgroup <name> (view members)
  return formatGroupMembers(ctx, groupName);
}

// ─── Formatting ────────────────────────────────────────────────────

function formatUserList(ctx: NetUserContext): string {
  const users = ctx.userManager.getAllUsers();
  const lines: string[] = [];
  lines.push('');
  lines.push(`User accounts for \\\\${ctx.hostname}`);
  lines.push('');
  lines.push('-'.repeat(60));

  // Display in 3-column format like real Windows
  const names = users.map(u => u.name);
  for (let i = 0; i < names.length; i += 3) {
    const cols = names.slice(i, i + 3).map(n => n.padEnd(24));
    lines.push(cols.join(''));
  }

  lines.push('-'.repeat(60));
  lines.push('The command completed successfully.');
  return lines.join('\n');
}

function userDate(d: Date, zone?: string): string {
  return formatDotNetDate(ZonedDate.in(d.getTime(), zone), 'M/d/yyyy h:mm:ss tt');
}

const DETAIL_INDENT = ' '.repeat(29);

function detail(label: string, value: string): string {
  return `${label.padEnd(29)}${value}`.trimEnd();
}

function formatUserDetails(ctx: NetUserContext, username: string): string {
  const user = ctx.userManager.getUser(username);
  if (!user) return netError('The user name could not be found.');

  const groups = ctx.userManager.getGroupsForUser(user.name);
  const localGroups = groups.map(g => `*${g.name}`).join('  ');
  const expiresAt = ctx.userManager.passwordExpiresAt(user.name);
  const minAge = ctx.userManager.passwordMinimumAgeDays();
  const hours = describeLogonHours(user.logonHours);

  const lines: string[] = [];
  lines.push(detail('User name', user.name));
  lines.push(detail('Full Name', user.fullName));
  lines.push(detail('Comment', user.description));
  lines.push(detail("User's comment", user.userComment ?? ''));
  lines.push(detail('Country/region code', describeCountryCode(user.countryCode ?? 0)));
  lines.push(detail('Account active', user.enabled ? 'Yes' : 'No'));
  lines.push(detail('Account expires', user.accountExpires ? userDate(user.accountExpires, 'UTC') : 'Never'));
  lines.push('');
  lines.push(detail('Password last set', userDate(user.passwordLastSet, ctx.timezone)));
  lines.push(detail('Password expires', expiresAt === null ? 'Never' : userDate(new Date(expiresAt), ctx.timezone)));
  lines.push(detail('Password changeable', userDate(new Date(user.passwordLastSet.getTime() + minAge * 86_400_000), ctx.timezone)));
  lines.push(detail('Password required', user.passwordRequired ? 'Yes' : 'No'));
  lines.push(detail('User may change password', user.userMayChangePassword ? 'Yes' : 'No'));
  lines.push('');
  lines.push(detail('Workstations allowed', user.workstations === undefined ? 'All' : user.workstations.join(',')));
  lines.push(detail('Logon script', user.scriptPath ?? ''));
  lines.push(detail('User profile', user.profilePath ?? ''));
  lines.push(detail('Home directory', user.homeDirectory ?? ''));
  lines.push(detail('Last logon', user.lastLogon ? userDate(user.lastLogon, ctx.timezone) : 'Never'));
  lines.push('');
  lines.push(detail('Logon hours allowed', hours[0]));
  for (const extra of hours.slice(1)) lines.push(`${DETAIL_INDENT}${extra}`);
  lines.push('');
  lines.push(detail('Local Group Memberships', localGroups || ''));
  lines.push(detail('Global Group memberships', '*None'));
  lines.push('The command completed successfully.');
  return lines.join('\n');
}

function formatDomainUserList(store: DirectoryStore, hostname: string): string {
  const names = store.listUsers().map(u => u.sam);
  const lines: string[] = [];
  lines.push('');
  lines.push(`User accounts for \\\\${hostname}`);
  lines.push('');
  lines.push('-'.repeat(60));
  for (let i = 0; i < names.length; i += 3) {
    lines.push(names.slice(i, i + 3).map(n => n.padEnd(24)).join(''));
  }
  lines.push('-'.repeat(60));
  lines.push('The command completed successfully.');
  return lines.join('\n');
}

function formatDomainUserDetails(store: DirectoryStore, username: string): string {
  const user = store.getUser(username);
  if (!user) return 'The user name could not be found.\n\nMore help is available by typing NET HELPMSG 2221.';
  const globalGroups = store.groupsForUser(user.sam).map(g => `*${g.sam}`).join('  ');

  const lines: string[] = [];
  lines.push(`User name                    ${user.sam}`);
  lines.push(`Full Name                    ${user.fullName}`);
  lines.push(`Comment`);
  lines.push(`User's comment`);
  lines.push(`Country/region code          000 (System Default)`);
  lines.push(`Account active               ${user.enabled ? 'Yes' : 'No'}`);
  lines.push(`Account expires              Never`);
  lines.push(``);
  lines.push(`Password expires             Never`);
  lines.push(``);
  lines.push(`Workstations allowed         All`);
  lines.push(`Logon script`);
  lines.push(`User profile`);
  lines.push(`Home directory`);
  lines.push(`Last logon                   Never`);
  lines.push(``);
  lines.push(`Logon hours allowed          All`);
  lines.push(``);
  lines.push(`Local Group Memberships`);
  lines.push(`Global Group memberships     ${globalGroups || '*None'}`);
  lines.push(`The command completed successfully.`);
  return lines.join('\n');
}

function formatGroupList(ctx: NetUserContext): string {
  const groups = ctx.userManager.getAllGroups();
  const lines: string[] = [];
  lines.push('');
  lines.push(`Aliases for \\\\${ctx.hostname}`);
  lines.push('');
  lines.push('-'.repeat(60));
  for (const g of groups) {
    lines.push(`*${g.name}`);
  }
  lines.push('-'.repeat(60));
  lines.push('The command completed successfully.');
  return lines.join('\n');
}

function formatGroupMembers(ctx: NetUserContext, groupName: string): string {
  const { members, error } = ctx.userManager.getGroupMembers(groupName);
  if (error) {
    return `The specified group could not be found.\n\nMore help is available by typing NET HELPMSG 3711.`;
  }
  const group = ctx.userManager.getGroup(groupName)!;

  const lines: string[] = [];
  lines.push(`Alias name     ${group.name}`);
  lines.push(`Comment        ${group.description}`);
  lines.push('');
  lines.push('Members');
  lines.push('');
  lines.push('-'.repeat(60));
  for (const member of members) {
    lines.push(member);
  }
  lines.push('-'.repeat(60));
  lines.push('The command completed successfully.');
  return lines.join('\n');
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
