import type { WindowsUserManager } from './WindowsUserManager';
import { parsePSArgs } from './psArgs';

export interface PSLocalAccountContext {
  userManager: WindowsUserManager;
}

export function psGetLocalUser(ctx: PSLocalAccountContext, args: string[]): string {
  const mgr = ctx.userManager;
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional');

  if (name) {
    const user = mgr.getUser(name);
    if (!user) return `Get-LocalUser : User not found. '${name}' was not found.`;
    const lines: string[] = [''];
    lines.push('Name'.padEnd(24) + 'Enabled'.padEnd(10) + 'Description');
    lines.push('----'.padEnd(24) + '-------'.padEnd(10) + '-----------');
    lines.push(
      user.name.padEnd(24) +
      (user.enabled ? 'True' : 'False').padEnd(10) +
      user.description
    );
    if (user.fullName) lines.push(`\nFullName: ${user.fullName}`);
    return lines.join('\n');
  }

  const users = mgr.getAllUsers();
  const lines: string[] = [''];
  lines.push('Name'.padEnd(24) + 'Enabled'.padEnd(10) + 'Description');
  lines.push('----'.padEnd(24) + '-------'.padEnd(10) + '-----------');
  for (const u of users) {
    lines.push(
      u.name.padEnd(24) +
      (u.enabled ? 'True' : 'False').padEnd(10) +
      u.description
    );
  }
  return lines.join('\n');
}

export function psNewLocalUser(ctx: PSLocalAccountContext, args: string[]): string {
  const mgr = ctx.userManager;
  if (!mgr.isCurrentUserAdmin()) return 'New-LocalUser : Access is denied.';
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  const password = params.get('password') || '';
  const description = params.get('description') || '';
  const noPassword = params.has('nopassword');

  if (!name) return "New-LocalUser : Cannot bind argument to parameter 'Name' because it is an empty string.";

  const err = mgr.createUser(name, password, { description, noPassword });
  if (err) {
    if (err.includes('already exists')) return `New-LocalUser : User '${name}' already exists.`;
    return `New-LocalUser : ${err}`;
  }
  mgr.addGroupMember('Users', name);
  return psGetLocalUser(ctx, ['-Name', name]);
}

export function psSetLocalUser(ctx: PSLocalAccountContext, args: string[]): string {
  const mgr = ctx.userManager;
  if (!mgr.isCurrentUserAdmin()) return 'Set-LocalUser : Access is denied.';
  const expanded: string[] = [];
  for (const a of args) {
    if (/^-AccountDisabled:/i.test(a)) {
      const val = a.split(':')[1];
      expanded.push('-AccountDisabled', val);
    } else {
      expanded.push(a);
    }
  }
  const params = parsePSArgs(expanded);
  const name = params.get('name') || params.get('_positional') || '';
  if (!name) return "Set-LocalUser : Cannot bind argument to parameter 'Name' because it is an empty string.";

  const user = mgr.getUser(name);
  if (!user) return `Set-LocalUser : User not found. No user named '${name}' exists on this computer.`;

  if (params.has('description')) {
    const err = mgr.setUserProperty(name, 'description', params.get('description')!);
    if (err) return `Set-LocalUser : ${err}`;
  }
  if (params.has('password')) {
    const err = mgr.setUserProperty(name, 'password', params.get('password')!);
    if (err) return `Set-LocalUser : ${err}`;
  }
  if (params.has('fullname')) {
    const err = mgr.setUserProperty(name, 'fullname', params.get('fullname')!);
    if (err) return `Set-LocalUser : ${err}`;
  }
  if (params.has('accountdisabled')) {
    const val = params.get('accountdisabled');
    const disable = val !== '$false' && val !== 'false';
    const err = disable ? mgr.disableUser(name) : mgr.enableUser(name);
    if (err) return `Set-LocalUser : ${err}`;
  }
  return '';
}

export function psRemoveLocalUser(ctx: PSLocalAccountContext, args: string[]): string {
  const mgr = ctx.userManager;
  if (!mgr.isCurrentUserAdmin()) return 'Remove-LocalUser : Access is denied.';
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  if (!name) return "Remove-LocalUser : Cannot bind argument to parameter 'Name' because it is an empty string.";

  const err = mgr.deleteUser(name);
  if (err) {
    if (err.includes('could not be found')) return `Remove-LocalUser : User '${name}' was not found.`;
    if (err.includes('Cannot delete')) return `Remove-LocalUser : ${err}`;
    return `Remove-LocalUser : ${err}`;
  }
  return '';
}

export function psEnableLocalUser(ctx: PSLocalAccountContext, args: string[]): string {
  const mgr = ctx.userManager;
  if (!mgr.isCurrentUserAdmin()) return 'Enable-LocalUser : Access is denied.';
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  if (!name) return "Enable-LocalUser : Cannot bind argument to parameter 'Name' because it is an empty string.";
  const err = mgr.enableUser(name);
  if (err) return `Enable-LocalUser : ${err}`;
  return '';
}

export function psDisableLocalUser(ctx: PSLocalAccountContext, args: string[]): string {
  const mgr = ctx.userManager;
  if (!mgr.isCurrentUserAdmin()) return 'Disable-LocalUser : Access is denied.';
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  if (!name) return "Disable-LocalUser : Cannot bind argument to parameter 'Name' because it is an empty string.";
  const err = mgr.disableUser(name);
  if (err) return `Disable-LocalUser : ${err}`;
  return '';
}

export function psGetLocalGroup(ctx: PSLocalAccountContext, args: string[]): string {
  const mgr = ctx.userManager;
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional');

  if (name) {
    const group = mgr.getGroup(name);
    if (!group) return `Get-LocalGroup : Group not found. '${name}' was not found.`;
    const lines: string[] = [''];
    lines.push('Name'.padEnd(36) + 'Description');
    lines.push('----'.padEnd(36) + '-----------');
    lines.push(group.name.padEnd(36) + group.description);
    return lines.join('\n');
  }

  const groups = mgr.getAllGroups();
  const lines: string[] = [''];
  lines.push('Name'.padEnd(36) + 'Description');
  lines.push('----'.padEnd(36) + '-----------');
  for (const g of groups) {
    lines.push(g.name.padEnd(36) + g.description);
  }
  return lines.join('\n');
}

export function psNewLocalGroup(ctx: PSLocalAccountContext, args: string[]): string {
  const mgr = ctx.userManager;
  if (!mgr.isCurrentUserAdmin()) return 'New-LocalGroup : Access is denied.';
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  const description = params.get('description') || '';
  if (!name) return "New-LocalGroup : Cannot bind argument to parameter 'Name' because it is an empty string.";

  const err = mgr.createGroup(name, description);
  if (err) return `New-LocalGroup : ${err}`;
  return psGetLocalGroup(ctx, ['-Name', name]);
}

export function psRemoveLocalGroup(ctx: PSLocalAccountContext, args: string[]): string {
  const mgr = ctx.userManager;
  if (!mgr.isCurrentUserAdmin()) return 'Remove-LocalGroup : Access is denied.';
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  if (!name) return "Remove-LocalGroup : Cannot bind argument to parameter 'Name' because it is an empty string.";

  const err = mgr.deleteGroup(name);
  if (err) {
    if (err.includes('Cannot delete')) return `Remove-LocalGroup : ${err}`;
    return `Remove-LocalGroup : ${err}`;
  }
  return '';
}

export function psAddLocalGroupMember(ctx: PSLocalAccountContext, args: string[]): string {
  const mgr = ctx.userManager;
  if (!mgr.isCurrentUserAdmin()) return 'Add-LocalGroupMember : Access is denied.';

  let group = '';
  const memberTokens: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const lower = args[i].toLowerCase();
    if (lower === '-group' && args[i + 1]) { group = args[++i].replace(/^["']|["']$/g, ''); }
    else if (lower === '-member') {
      i++;
      while (i < args.length && !args[i].startsWith('-')) {
        memberTokens.push(args[i]);
        i++;
      }
      i--;
    } else if (!args[i].startsWith('-') && !group) {
      group = args[i].replace(/^["']|["']$/g, '');
    }
  }
  const memberRaw = memberTokens.join(' ');
  if (!group || !memberRaw) return "Add-LocalGroupMember : Cannot bind required parameter.";

  const members = memberRaw.split(',').map(m => m.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const errors: string[] = [];
  for (const member of members) {
    const err = mgr.addGroupMember(group, member);
    if (err) {
      if (err.includes('was not found') || err.includes('could not be found')) {
        errors.push(`Add-LocalGroupMember : Cannot find user '${member}'. The specified user was not found.`);
      } else if (err.includes('already a member')) {
        errors.push(`Add-LocalGroupMember : The specified account '${member}' is already a member of the group.`);
      } else {
        errors.push(`Add-LocalGroupMember : ${err}`);
      }
    }
  }
  return errors.join('\n');
}

export function psRemoveLocalGroupMember(ctx: PSLocalAccountContext, args: string[]): string {
  const mgr = ctx.userManager;
  if (!mgr.isCurrentUserAdmin()) return 'Remove-LocalGroupMember : Access is denied.';
  const params = parsePSArgs(args);
  const group = params.get('group') || '';
  const member = params.get('member') || '';
  if (!group || !member) return "Remove-LocalGroupMember : Cannot bind required parameter.";

  const err = mgr.removeGroupMember(group, member);
  if (err) return `Remove-LocalGroupMember : ${err}`;
  return '';
}

export function psGetLocalGroupMember(ctx: PSLocalAccountContext, args: string[]): string {
  const mgr = ctx.userManager;
  const params = parsePSArgs(args);
  const groupName = params.get('group') || '';
  if (!groupName) return "Get-LocalGroupMember : Cannot bind required parameter 'Group'.";

  const { members, error } = mgr.getGroupMembers(groupName);
  if (error) return `Get-LocalGroupMember : ${error}`;

  const lines: string[] = [''];
  lines.push('ObjectClass'.padEnd(16) + 'Name'.padEnd(30) + 'PrincipalSource');
  lines.push('-----------'.padEnd(16) + '----'.padEnd(30) + '---------------');
  for (const m of members) {
    lines.push('User'.padEnd(16) + m.padEnd(30) + 'Local');
  }
  return lines.join('\n');
}

export function psRenameLocalUser(ctx: PSLocalAccountContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  const newName = params.get('newname') || '';
  if (!name) return "Rename-LocalUser : The -Name parameter is required.";
  if (!newName) return "Rename-LocalUser : The -NewName parameter is required.";
  const error = ctx.userManager.renameUser(name, newName);
  return error || '';
}

export function psRenameLocalGroup(ctx: PSLocalAccountContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name') || params.get('_positional') || '';
  const newName = params.get('newname') || '';
  if (!name) return "Rename-LocalGroup : The -Name parameter is required.";
  if (!newName) return "Rename-LocalGroup : The -NewName parameter is required.";
  const error = ctx.userManager.renameGroup(name, newName);
  return error || '';
}

export const LOCAL_ACCOUNT_CMDLETS: Record<string, (ctx: PSLocalAccountContext, args: string[]) => string> = {
  'get-localuser': psGetLocalUser,
  'new-localuser': psNewLocalUser,
  'set-localuser': psSetLocalUser,
  'remove-localuser': psRemoveLocalUser,
  'enable-localuser': psEnableLocalUser,
  'disable-localuser': psDisableLocalUser,
  'rename-localuser': psRenameLocalUser,
  'get-localgroup': psGetLocalGroup,
  'new-localgroup': psNewLocalGroup,
  'remove-localgroup': psRemoveLocalGroup,
  'rename-localgroup': psRenameLocalGroup,
  'add-localgroupmember': psAddLocalGroupMember,
  'remove-localgroupmember': psRemoveLocalGroupMember,
  'get-localgroupmember': psGetLocalGroupMember,
};
