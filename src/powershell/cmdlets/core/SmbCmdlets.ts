/**
 * SmbCmdlets — New/Get/Remove-SmbShare, Get-SmbSession, and the
 * New/Get/Remove-SmbMapping family (PRD-Windows-Server.md §5 P3).
 *
 * Provider: ctx.providers.smb (ISmbProvider). Serving a share is
 * live-gated on the FS-FileServer role (PRD §8 acceptance criterion 2);
 * mapping one is not, because any Windows machine maps a drive — see
 * WindowsSmbAdapter.
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
  readonly parameterValues = { Path: 'path' } as const;

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

// ─── SMB mappings — the same table `net use` and `New-PSDrive` read ────────

/**
 * Transport settings a real `New-SmbMapping` takes and this simulator
 * cannot honour: signing, encryption, QUIC/RDMA transports and the rest.
 * Naming them in a refusal is the only honest answer — accepting one and
 * doing nothing would have every appearance of working.
 */
const UNHONOURED_MAPPING_SETTINGS = [
  'RequireIntegrity', 'RequirePrivacy', 'BlockNTLM', 'CompressNetworkTraffic',
  'TransportType', 'QuicPort', 'RdmaPort', 'TcpPort', 'SkipCertificateCheck',
  'UseWriteThrough', 'GlobalMapping',
] as const;

function refusedMappingSetting(ctx: CmdletContext): string | null {
  for (const setting of UNHONOURED_MAPPING_SETTINGS) {
    if (ctx.named[setting.toLowerCase()] !== undefined) return setting;
  }
  return null;
}

function mappingToPSObject(m: { local: string; remote: string; status: string; user: string }): Record<string, PSValue> {
  return { Status: m.status, LocalPath: m.local, RemotePath: m.remote, UserName: m.user };
}

function mappingsOf(smb: ISmbProvider): Array<{ local: string; remote: string; status: string; user: string }> {
  return smb.listMappings?.() ?? [];
}

export class GetSmbMappingCmdlet implements ICmdlet {
  readonly name = 'get-smbmapping';
  readonly displayName = 'Get-SmbMapping';
  readonly aliases = [] as const;
  readonly parameters = ['LocalPath', 'RemotePath'] as const;

  execute(ctx: CmdletContext): PSValue {
    const smb = requireSmb(ctx);
    const local = psValueToString(ctx.named['localpath'] ?? ctx.positional[0] ?? '').toLowerCase();
    const remote = psValueToString(ctx.named['remotepath'] ?? ctx.positional[1] ?? '').toLowerCase();
    return mappingsOf(smb)
      .filter(m => !local || m.local.toLowerCase() === local)
      .filter(m => !remote || m.remote.toLowerCase() === remote)
      .map(mappingToPSObject) as PSValue;
  }
}

export class NewSmbMappingCmdlet implements ICmdlet {
  readonly name = 'new-smbmapping';
  readonly displayName = 'New-SmbMapping';
  readonly aliases = [] as const;
  readonly parameters = ['LocalPath', 'RemotePath', 'UserName', 'Password', 'Persistent',
    'SaveCredentials', 'HomeFolder', 'Credential', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const smb = requireSmb(ctx);
    const refused = refusedMappingSetting(ctx);
    if (refused) {
      ctx.emitError(`New-SmbMapping : -${refused} cannot be honoured here — this SMB stack carries no signing, encryption or alternate-transport negotiation to apply it to.`);
      return null;
    }
    if (!smb.mapDrive) {
      ctx.emitError('New-SmbMapping : This computer cannot map a network drive.');
      return null;
    }
    const localRaw = psValueToString(ctx.named['localpath'] ?? ctx.positional[0] ?? '');
    const remote = psValueToString(ctx.named['remotepath'] ?? ctx.positional[1] ?? '');
    if (!remote) {
      ctx.emitError('New-SmbMapping : Cannot process command because of one or more missing mandatory parameters: RemotePath.');
      return null;
    }
    const local = localRaw && !localRaw.endsWith(':') ? `${localRaw}:` : localRaw;
    const userName = ctx.named['username'] !== undefined ? psValueToString(ctx.named['username']) : '';
    const password = ctx.named['password'] !== undefined ? psValueToString(ctx.named['password']) : '';
    const credential = userName ? { username: userName, password } : undefined;

    const mapped = smb.mapDrive(local, remote, credential);
    if (!mapped.ok) {
      ctx.emitError(`New-SmbMapping : ${mapped.error ?? 'The network path was not found.'}`);
      return null;
    }
    const created = mappingsOf(smb).find(m => m.remote.toLowerCase() === remote.toLowerCase());
    return created ? mappingToPSObject(created) : null;
  }
}

export class RemoveSmbMappingCmdlet implements ICmdlet {
  readonly name = 'remove-smbmapping';
  readonly displayName = 'Remove-SmbMapping';
  readonly aliases = [] as const;
  readonly parameters = ['LocalPath', 'RemotePath', 'Force', 'UpdateProfile', 'PassThru', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const smb = requireSmb(ctx);
    const local = psValueToString(ctx.named['localpath'] ?? ctx.positional[0] ?? '');
    const remote = psValueToString(ctx.named['remotepath'] ?? ctx.positional[1] ?? '');
    const target = local ? (local.endsWith(':') ? local : `${local}:`) : remote;
    if (!target) {
      ctx.emitError('Remove-SmbMapping : Cannot process command because of one or more missing mandatory parameters: LocalPath.');
      return null;
    }
    const gone = mappingsOf(smb).find(m =>
      (local && m.local.toLowerCase() === target.toLowerCase())
      || (!local && m.remote.toLowerCase() === target.toLowerCase()));
    if (!smb.unmapDrive?.(target)) {
      ctx.emitError(`Remove-SmbMapping : Cannot find the mapping '${target}'.`);
      return null;
    }
    return ctx.named['passthru'] !== undefined && gone ? mappingToPSObject(gone) : null;
  }
}
