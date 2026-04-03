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

import type { WindowsUserManager } from './WindowsUserManager';

export interface NetUserContext {
  hostname: string;
  userManager: WindowsUserManager;
}

// ─── net user ─────────────────────────────────────────────────────

export function cmdNetUser(ctx: NetUserContext, args: string[]): string {
  if (args.length === 0) {
    return formatUserList(ctx);
  }

  // Parse flags
  const flags = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.toLowerCase() === '/add') {
      flags.set('add', 'true');
    } else if (arg.toLowerCase() === '/delete') {
      flags.set('delete', 'true');
    } else if (arg.toLowerCase().startsWith('/active:')) {
      flags.set('active', arg.substring(8));
    } else if (arg.toLowerCase().startsWith('/fullname:')) {
      flags.set('fullname', stripQuotes(arg.substring(10)));
    } else if (arg.toLowerCase().startsWith('/comment:')) {
      flags.set('comment', stripQuotes(arg.substring(9)));
    } else {
      positional.push(arg);
    }
  }

  const username = positional[0];
  if (!username) return 'The syntax of this command is:\n\nNET USER [username [password | *] [options]] [/DOMAIN]\n         username {password | *} /ADD [options] [/DOMAIN]\n         username [/DELETE] [/DOMAIN]';

  // net user <name> /add
  if (flags.has('add')) {
    const password = positional[1] || '';
    const err = ctx.userManager.createUser(username, password);
    if (err) return `System error.\n\n${err}`;
    // Add to Users group by default
    ctx.userManager.addGroupMember('Users', username);
    return 'The command completed successfully.';
  }

  // net user <name> /delete
  if (flags.has('delete')) {
    if (!ctx.userManager.isCurrentUserAdmin()) return 'System error.\n\nAccess is denied.';
    const err = ctx.userManager.deleteUser(username);
    if (err) return `System error.\n\n${err}`;
    return 'The command completed successfully.';
  }

  // net user <name> /active:yes|no
  if (flags.has('active')) {
    const err = ctx.userManager.setUserProperty(username, 'active', flags.get('active')!);
    if (err) return `System error.\n\n${err}`;
    return 'The command completed successfully.';
  }

  // net user <name> /fullname:"x"
  if (flags.has('fullname')) {
    const err = ctx.userManager.setUserProperty(username, 'fullname', flags.get('fullname')!);
    if (err) return `System error.\n\n${err}`;
    return 'The command completed successfully.';
  }

  // net user <name> /comment:"x"
  if (flags.has('comment')) {
    const err = ctx.userManager.setUserProperty(username, 'comment', flags.get('comment')!);
    if (err) return `System error.\n\n${err}`;
    return 'The command completed successfully.';
  }

  // net user <name> <password> (change password)
  if (positional.length >= 2) {
    const err = ctx.userManager.setUserProperty(username, 'password', positional[1]);
    if (err) return `System error.\n\n${err}`;
    return 'The command completed successfully.';
  }

  // net user <name> (view details)
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
    if (!ctx.userManager.isCurrentUserAdmin()) return 'System error.\n\nAccess is denied.';
    const err = ctx.userManager.addGroupMember(groupName, memberName);
    if (err) {
      if (err.includes('was not found')) return `System error.\n\nThe user name could not be found.`;
      if (err.includes('already a member')) return `System error.\n\nThe specified account name is already a member of the group.`;
      return `System error.\n\n${err}`;
    }
    return 'The command completed successfully.';
  }

  // net localgroup <name> /add (create group)
  if (flags.has('add') && !memberName) {
    if (!ctx.userManager.isCurrentUserAdmin()) return 'System error.\n\nAccess is denied.';
    const desc = flags.get('comment') || '';
    const err = ctx.userManager.createGroup(groupName, desc);
    if (err) return `System error.\n\n${err}`;
    return 'The command completed successfully.';
  }

  // net localgroup <name> <member> /delete
  if (flags.has('delete') && memberName) {
    if (!ctx.userManager.isCurrentUserAdmin()) return 'System error.\n\nAccess is denied.';
    const err = ctx.userManager.removeGroupMember(groupName, memberName);
    if (err) return `System error.\n\n${err}`;
    return 'The command completed successfully.';
  }

  // net localgroup <name> /delete (delete group)
  if (flags.has('delete') && !memberName) {
    if (!ctx.userManager.isCurrentUserAdmin()) return 'System error.\n\nAccess is denied.';
    const err = ctx.userManager.deleteGroup(groupName);
    if (err) return `System error.\n\n${err}`;
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

function formatUserDetails(ctx: NetUserContext, username: string): string {
  const user = ctx.userManager.getUser(username);
  if (!user) return 'The user name could not be found.\n\nMore help is available by typing NET HELPMSG 2221.';

  const groups = ctx.userManager.getGroupsForUser(user.name);
  const localGroups = groups.map(g => `*${g.name}`).join('  ');

  const lines: string[] = [];
  lines.push(`User name                    ${user.name}`);
  lines.push(`Full Name                    ${user.fullName}`);
  lines.push(`Comment                      ${user.description}`);
  lines.push(`User's comment`);
  lines.push(`Country/region code          000 (System Default)`);
  lines.push(`Account active               ${user.enabled ? 'Yes' : 'No'}`);
  lines.push(`Account expires              Never`);
  lines.push(``);
  lines.push(`Password last set            ${user.passwordLastSet.toLocaleDateString('en-US')}`);
  lines.push(`Password expires             Never`);
  lines.push(`Password changeable          ${user.passwordLastSet.toLocaleDateString('en-US')}`);
  lines.push(`Password required            ${user.passwordRequired ? 'Yes' : 'No'}`);
  lines.push(`User may change password     ${user.userMayChangePassword ? 'Yes' : 'No'}`);
  lines.push(``);
  lines.push(`Workstations allowed         All`);
  lines.push(`Logon script`);
  lines.push(`User profile`);
  lines.push(`Home directory`);
  lines.push(`Last logon                   ${user.lastLogon ? user.lastLogon.toLocaleDateString('en-US') : 'Never'}`);
  lines.push(``);
  lines.push(`Logon hours allowed          All`);
  lines.push(``);
  lines.push(`Local Group Memberships      ${localGroups || '(none)'}`);
  lines.push(`Global Group memberships     *None`);
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
