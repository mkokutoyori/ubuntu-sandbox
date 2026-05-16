/**
 * UserCmdlets — Get/New/Set/Remove/Enable/Disable/Rename-LocalUser
 *               Get/New/Remove-LocalGroup
 *               Add/Remove/Get-LocalGroupMember
 *
 * All routing goes through `ctx.providers.users`.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { UserInfo, GroupInfo, IUserProvider } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

function requireUsers(ctx: CmdletContext): IUserProvider {
  if (!ctx.providers.users) {
    throw new PSRuntimeError('Get-LocalUser is not recognized as a user provider operation in this context');
  }
  return ctx.providers.users;
}

function userToPSObject(u: UserInfo): Record<string, PSValue> {
  return {
    Name:             u.name,
    FullName:         u.fullName,
    Description:      u.description,
    SID:              u.sid,
    Enabled:          u.enabled,
    PasswordRequired: u.passwordRequired,
    LastLogon:        u.lastLogon,
  };
}

function groupToPSObject(g: GroupInfo): Record<string, PSValue> {
  return {
    Name:        g.name,
    Description: g.description,
    SID:         g.sid,
    Members:     [...g.members] as PSValue,
  };
}

function pickName(ctx: CmdletContext, paramName = 'name'): string | string[] | null {
  const named = ctx.named[paramName];
  if (named !== undefined && named !== null && named !== '') {
    return Array.isArray(named) ? named.map(psValueToString) : psValueToString(named);
  }
  if (ctx.positional.length > 0) {
    const p = ctx.positional[0];
    return Array.isArray(p) ? p.map(psValueToString) : psValueToString(p);
  }
  return null;
}

// ── Get-LocalUser ─────────────────────────────────────────────────────────

export class GetLocalUserCmdlet implements ICmdlet {
  readonly name = 'get-localuser';
  readonly displayName = 'Get-LocalUser';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const users = requireUsers(ctx);
    const name  = pickName(ctx);
    if (name === null) return users.listUsers().map(userToPSObject) as PSValue;
    const names = Array.isArray(name) ? name : [name];
    const out: UserInfo[] = [];
    for (const n of names) {
      if (/[*?]/.test(n)) {
        const pat = new RegExp('^' + n.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        for (const u of users.listUsers()) if (pat.test(u.name)) out.push(u);
        continue;
      }
      const u = users.getUser(n);
      if (u) out.push(u);
      else ctx.emitError(`User ${n} was not found.`);
    }
    return out.map(userToPSObject) as PSValue;
  }
}

// ── New-LocalUser ─────────────────────────────────────────────────────────

export class NewLocalUserCmdlet implements ICmdlet {
  readonly name = 'new-localuser';
  readonly displayName = 'New-LocalUser';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const users = requireUsers(ctx);
    const name  = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('New-LocalUser requires -Name'); return null; }

    const opts = {
      password:    ctx.named['password']    ? psValueToString(ctx.named['password'])    : undefined,
      fullName:    ctx.named['fullname']    ? psValueToString(ctx.named['fullname'])    : undefined,
      description: ctx.named['description'] ? psValueToString(ctx.named['description']) : undefined,
    };
    const msg = users.createUser(name, opts);
    if (msg && /error|denied|exists/i.test(msg)) ctx.emitError(msg);
    const u = users.getUser(name);
    return u ? userToPSObject(u) : null;
  }
}

// ── Set-LocalUser ─────────────────────────────────────────────────────────

export class SetLocalUserCmdlet implements ICmdlet {
  readonly name = 'set-localuser';
  readonly displayName = 'Set-LocalUser';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const users = requireUsers(ctx);
    const name  = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('Set-LocalUser requires -Name'); return null; }

    const opts: { enabled?: boolean; fullName?: string; description?: string; password?: string } = {};
    if (ctx.named['fullname']    !== undefined) opts.fullName    = psValueToString(ctx.named['fullname']);
    if (ctx.named['description'] !== undefined) opts.description = psValueToString(ctx.named['description']);
    if (ctx.named['password']    !== undefined) opts.password    = psValueToString(ctx.named['password']);
    if (ctx.named['enabled']     !== undefined) opts.enabled     = ctx.named['enabled'] === true;

    const msg = users.setUser(name, opts);
    if (msg && /error|denied|not found/i.test(msg)) ctx.emitError(msg);
    return null;
  }
}

// ── Remove-LocalUser / Enable / Disable / Rename ──────────────────────────

abstract class UserActionCmdlet implements ICmdlet {
  abstract readonly name: string;
  abstract readonly aliases: readonly string[];
  protected abstract act(users: IUserProvider, name: string, ctx: CmdletContext): string;

  execute(ctx: CmdletContext): PSValue {
    const users = requireUsers(ctx);
    const name  = pickName(ctx);
    if (name === null) { ctx.emitError(`${this.name} requires -Name`); return null; }
    const names = Array.isArray(name) ? name : [name];
    for (const n of names) {
      const msg = this.act(users, n, ctx);
      if (msg && /error|denied|not found/i.test(msg)) ctx.emitError(msg);
    }
    return null;
  }
}

export class RemoveLocalUserCmdlet extends UserActionCmdlet {
  readonly name = 'remove-localuser';
  readonly displayName = 'Remove-LocalUser';
  readonly aliases = [] as const;
  protected act(u: IUserProvider, n: string) { return u.removeUser(n); }
}
export class EnableLocalUserCmdlet extends UserActionCmdlet {
  readonly name = 'enable-localuser';
  readonly displayName = 'Enable-LocalUser';
  readonly aliases = [] as const;
  protected act(u: IUserProvider, n: string) { return u.enableUser(n); }
}
export class DisableLocalUserCmdlet extends UserActionCmdlet {
  readonly name = 'disable-localuser';
  readonly displayName = 'Disable-LocalUser';
  readonly aliases = [] as const;
  protected act(u: IUserProvider, n: string) { return u.disableUser(n); }
}
export class RenameLocalUserCmdlet implements ICmdlet {
  readonly name = 'rename-localuser';
  readonly displayName = 'Rename-LocalUser';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const users = requireUsers(ctx);
    const oldName = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const newName = psValueToString(ctx.named['newname'] ?? ctx.positional[1] ?? '');
    if (!oldName || !newName) {
      ctx.emitError('Rename-LocalUser requires -Name and -NewName');
      return null;
    }
    const msg = users.renameUser(oldName, newName);
    if (msg && /error|denied|not found/i.test(msg)) ctx.emitError(msg);
    return null;
  }
}

// ── Get / New / Remove-LocalGroup ─────────────────────────────────────────

export class GetLocalGroupCmdlet implements ICmdlet {
  readonly name = 'get-localgroup';
  readonly displayName = 'Get-LocalGroup';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const users = requireUsers(ctx);
    const name  = pickName(ctx);
    if (name === null) return users.listGroups().map(groupToPSObject) as PSValue;
    const names = Array.isArray(name) ? name : [name];
    const out: GroupInfo[] = [];
    for (const n of names) {
      const g = users.getGroup(n);
      if (g) out.push(g);
      else ctx.emitError(`Group ${n} was not found.`);
    }
    return out.map(groupToPSObject) as PSValue;
  }
}

export class NewLocalGroupCmdlet implements ICmdlet {
  readonly name = 'new-localgroup';
  readonly displayName = 'New-LocalGroup';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const users = requireUsers(ctx);
    const name  = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('New-LocalGroup requires -Name'); return null; }
    const description = ctx.named['description'] ? psValueToString(ctx.named['description']) : undefined;
    const msg = users.createGroup(name, { description });
    if (msg && /error|denied|exists/i.test(msg)) ctx.emitError(msg);
    const g = users.getGroup(name);
    return g ? groupToPSObject(g) : null;
  }
}

export class RemoveLocalGroupCmdlet implements ICmdlet {
  readonly name = 'remove-localgroup';
  readonly displayName = 'Remove-LocalGroup';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const users = requireUsers(ctx);
    const name  = pickName(ctx);
    if (name === null) { ctx.emitError('Remove-LocalGroup requires -Name'); return null; }
    const names = Array.isArray(name) ? name : [name];
    for (const n of names) {
      const msg = users.removeGroup(n);
      if (msg && /error|denied|not found/i.test(msg)) ctx.emitError(msg);
    }
    return null;
  }
}

// ── Add / Remove / Get-LocalGroupMember ───────────────────────────────────

abstract class GroupMemberCmdlet implements ICmdlet {
  abstract readonly name: string;
  abstract readonly aliases: readonly string[];
  protected abstract act(users: IUserProvider, group: string, member: string): string;

  execute(ctx: CmdletContext): PSValue {
    const users  = requireUsers(ctx);
    const group  = psValueToString(ctx.named['group']  ?? ctx.positional[0] ?? '');
    const member = ctx.named['member'] ?? ctx.named['members'] ?? ctx.positional[1];
    if (!group || member === undefined || member === null) {
      ctx.emitError(`${this.name} requires -Group and -Member`);
      return null;
    }
    const members = Array.isArray(member) ? member : [member];
    for (const m of members) {
      const msg = this.act(users, group, psValueToString(m));
      if (msg && /error|denied|not found/i.test(msg)) ctx.emitError(msg);
    }
    return null;
  }
}

export class AddLocalGroupMemberCmdlet extends GroupMemberCmdlet {
  readonly name = 'add-localgroupmember';
  readonly displayName = 'Add-LocalGroupMember';
  readonly aliases = [] as const;
  protected act(u: IUserProvider, g: string, m: string) { return u.addGroupMember(g, m); }
}
export class RemoveLocalGroupMemberCmdlet extends GroupMemberCmdlet {
  readonly name = 'remove-localgroupmember';
  readonly displayName = 'Remove-LocalGroupMember';
  readonly aliases = [] as const;
  protected act(u: IUserProvider, g: string, m: string) { return u.removeGroupMember(g, m); }
}

export class RenameLocalGroupCmdlet implements ICmdlet {
  readonly name = 'rename-localgroup';
  readonly displayName = 'Rename-LocalGroup';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    void ctx;
    // The current IUserProvider doesn't expose group rename; defer to the
    // legacy executor whose handler does the in-place rename.
    throw new PSRuntimeError('Rename-LocalGroup is not recognized in this provider context');
  }
}

export class GetLocalGroupMemberCmdlet implements ICmdlet {
  readonly name = 'get-localgroupmember';
  readonly displayName = 'Get-LocalGroupMember';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const users = requireUsers(ctx);
    const group = psValueToString(ctx.named['group'] ?? ctx.positional[0] ?? '');
    if (!group) { ctx.emitError('Get-LocalGroupMember requires -Group'); return null; }
    const members = users.getGroupMembers(group);
    return members.map(u => ({
      ObjectClass:     'User',
      Name:            u.name,
      PrincipalSource: 'Local',
      SID:             u.sid,
    })) as PSValue;
  }
}
