/**
 * SmbCmdlets — New/Get/Remove-SmbShare, Get-SmbSession
 * (PRD-Windows-Server.md §5 P3).
 *
 * Provider: ctx.providers.smb (ISmbProvider), populated only for a
 * `WindowsServer` device and live-gated on the FS-FileServer role being
 * installed (PRD §8 acceptance criterion 2) — see WindowsSmbAdapter.
 * When absent, these throw the same "not recognized" signal every other
 * provider-backed cmdlet uses, falling through to the real "term ... is
 * not recognized" message.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { ISmbProvider, SmbShareInfo, SmbSessionInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function requireSmb(ctx: CmdletContext): ISmbProvider {
  if (!ctx.providers.smb) {
    throw new PSRuntimeError(commandNotFoundMessage('New-SmbShare'));
  }
  return ctx.providers.smb;
}

function shareToPSObject(s: SmbShareInfo): Record<string, PSValue> {
  return {
    Name: s.name, Path: s.path, Description: s.description,
    ShareState: 'Online', ShareType: s.special ? 'Special' : 'FileSystemDirectory',
    ScopeName: '*',
  };
}

function sessionToPSObject(s: SmbSessionInfo): Record<string, PSValue> {
  return {
    SessionId: s.id, ClientComputerName: s.clientComputerName, ClientUserName: s.user,
    NumOpens: s.numOpens, Shares: s.shares.join(', '),
  };
}

function namesOf(ctx: CmdletContext): string[] {
  const raw = ctx.named['name'] ?? (ctx.positional.length > 0 ? ctx.positional[0] : undefined);
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(psValueToString) : [psValueToString(raw)];
}

function principalsOf(ctx: CmdletContext, key: string): string[] {
  const raw = ctx.named[key];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(psValueToString) : [psValueToString(raw)];
}

// ── Get-SmbShare ─────────────────────────────────────────────────────────────

export class GetSmbShareCmdlet implements ICmdlet {
  readonly name = 'get-smbshare';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const smb = requireSmb(ctx);
    const names = namesOf(ctx);
    if (names.length === 0) return smb.listShares().map(shareToPSObject) as PSValue;
    const out: Record<string, PSValue>[] = [];
    for (const n of names) {
      const s = smb.getShare(n);
      if (!s) { ctx.emitError(`Get-SmbShare : No SMB share exists with the name "${n}".`); continue; }
      out.push(shareToPSObject(s));
    }
    return out as PSValue;
  }
}

// ── New-SmbShare ─────────────────────────────────────────────────────────────

export class NewSmbShareCmdlet implements ICmdlet {
  readonly name = 'new-smbshare';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Path', 'Description', 'FullAccess', 'ChangeAccess', 'ReadAccess'] as const;

  execute(ctx: CmdletContext): PSValue {
    const smb = requireSmb(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const path = psValueToString(ctx.named['path'] ?? ctx.positional[1] ?? '');
    if (!name || !path) {
      ctx.emitError('New-SmbShare : Cannot process command because of one or more missing mandatory parameters: Name Path.');
      return null;
    }
    const res = smb.newShare(name, path, {
      fullAccess: principalsOf(ctx, 'fullaccess'),
      changeAccess: principalsOf(ctx, 'changeaccess'),
      readAccess: principalsOf(ctx, 'readaccess'),
    });
    if (!res.ok) { ctx.emitError(`New-SmbShare : ${res.message}`); return null; }
    const share = smb.getShare(name);
    return share ? shareToPSObject(share) : null;
  }
}

// ── Remove-SmbShare ──────────────────────────────────────────────────────────

export class RemoveSmbShareCmdlet implements ICmdlet {
  readonly name = 'remove-smbshare';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Force'] as const;

  execute(ctx: CmdletContext): PSValue {
    const smb = requireSmb(ctx);
    for (const n of namesOf(ctx)) {
      const res = smb.removeShare(n);
      if (!res.ok) ctx.emitError(`Remove-SmbShare : ${res.message}`);
    }
    return null;
  }
}

// ── Get-SmbSession ───────────────────────────────────────────────────────────

export class GetSmbSessionCmdlet implements ICmdlet {
  readonly name = 'get-smbsession';
  readonly aliases = [] as const;
  readonly parameters = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const smb = requireSmb(ctx);
    return smb.listSessions().map(sessionToPSObject) as PSValue;
  }
}
