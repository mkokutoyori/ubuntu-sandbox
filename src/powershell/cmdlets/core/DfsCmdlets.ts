/**
 * DfsCmdlets — DFS Namespaces + DFSR (PRD-Windows-Server-Advanced.md §5
 * P16, §2.1.15): `New-DfsnRoot`/`New-DfsnFolder`/`New-DfsnFolderTarget`/
 * `Get-DfsnFolder` build a logical namespace redirecting to real
 * `smbShares` targets; `New-DfsReplicationGroup`/`Sync-DfsReplicationGroup`
 * reuse the same USN/high-watermark replication patron as AD replication
 * (§5 P4), applied to file metadata instead of directory objects.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IDfsProvider, DfsFolderInfo, DfsNamespaceTypeInfo, DfsReferralPriorityClassInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { parseNamespacePath, parseUncTarget } from '@/network/devices/windows/server/dfs/DfsNamespace';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function requireDfs(ctx: CmdletContext, cmdletName: string): IDfsProvider {
  if (!ctx.providers.dfs) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  }
  return ctx.providers.dfs;
}

function pathOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['path'] ?? ctx.positional[0] ?? '');
}

function stringArrayOf(value: PSValue): string[] {
  return Array.isArray(value) ? value.map(psValueToString) : [psValueToString(value)];
}

function folderToPSObject(f: DfsFolderInfo): Record<string, PSValue> {
  return {
    Path: `${f.namespacePath}\\${f.folderName}`,
    Description: f.description,
    TargetPaths: f.targets.map(t => `\\\\${t.serverAddress}\\${t.shareName}`),
  };
}

// ── New-DfsnRoot ─────────────────────────────────────────────────────────

export class NewDfsnRootCmdlet implements ICmdlet {
  readonly name = 'new-dfsnroot';
  readonly aliases = [] as const;
  readonly parameters = ['Path', 'Type', 'TargetPath', 'Description'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'New-DfsnRoot');
    const path = pathOf(ctx);
    if (!path) {
      ctx.emitError('New-DfsnRoot : Cannot process command because of one or more missing mandatory parameters: Path.');
      return null;
    }
    const type = ctx.named['type'] !== undefined ? psValueToString(ctx.named['type']) as DfsNamespaceTypeInfo : undefined;
    const description = ctx.named['description'] !== undefined ? psValueToString(ctx.named['description']) : undefined;
    const targetPath = ctx.named['targetpath'] !== undefined ? psValueToString(ctx.named['targetpath']) : undefined;
    const target = targetPath ? parseUncTarget(targetPath) ?? undefined : undefined;
    const res = dfs.newDfsnRoot(path, { type, description, target });
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── Get-DfsnRoot ─────────────────────────────────────────────────────────

export class GetDfsnRootCmdlet implements ICmdlet {
  readonly name = 'get-dfsnroot';
  readonly aliases = [] as const;
  readonly parameters = ['Path'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'Get-DfsnRoot');
    const path = pathOf(ctx);
    const root = dfs.getDfsnRoot(path);
    if (!root) { ctx.emitError('Get-DfsnRoot : No MSDFS objects found.'); return null; }
    return { Path: root.namespacePath, Type: root.type, Description: root.description } as Record<string, PSValue>;
  }
}

// ── New-DfsnFolder ───────────────────────────────────────────────────────

export class NewDfsnFolderCmdlet implements ICmdlet {
  readonly name = 'new-dfsnfolder';
  readonly aliases = [] as const;
  readonly parameters = ['Path', 'TargetPath', 'Description'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'New-DfsnFolder');
    const path = pathOf(ctx);
    const targetPath = psValueToString(ctx.named['targetpath'] ?? '');
    const description = ctx.named['description'] !== undefined ? psValueToString(ctx.named['description']) : '';
    const parsed = parseNamespacePath(path);
    const target = parseUncTarget(targetPath);
    if (!parsed || !target) {
      ctx.emitError('New-DfsnFolder : Cannot process command because of one or more missing mandatory parameters: Path TargetPath.');
      return null;
    }
    const res = dfs.newDfsnFolder(parsed.namespacePath, parsed.folderName, target, description);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    const folder = dfs.getDfsnFolder(parsed.namespacePath, parsed.folderName);
    return folder ? folderToPSObject(folder) : null;
  }
}

// ── New-DfsnFolderTarget ─────────────────────────────────────────────────

export class NewDfsnFolderTargetCmdlet implements ICmdlet {
  readonly name = 'new-dfsnfoldertarget';
  readonly aliases = [] as const;
  readonly parameters = ['Path', 'TargetPath'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'New-DfsnFolderTarget');
    const path = pathOf(ctx);
    const targetPath = psValueToString(ctx.named['targetpath'] ?? '');
    const parsed = parseNamespacePath(path);
    const target = parseUncTarget(targetPath);
    if (!parsed || !target) {
      ctx.emitError('New-DfsnFolderTarget : Cannot process command because of one or more missing mandatory parameters: Path TargetPath.');
      return null;
    }
    const res = dfs.addDfsnFolderTarget(parsed.namespacePath, parsed.folderName, target);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    const folder = dfs.getDfsnFolder(parsed.namespacePath, parsed.folderName);
    return folder ? folderToPSObject(folder) : null;
  }
}

// ── Get-DfsnFolder ───────────────────────────────────────────────────────

export class GetDfsnFolderCmdlet implements ICmdlet {
  readonly name = 'get-dfsnfolder';
  readonly aliases = [] as const;
  readonly parameters = ['Path'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'Get-DfsnFolder');
    const path = pathOf(ctx);
    const parsed = parseNamespacePath(path);
    if (!parsed) {
      ctx.emitError('Get-DfsnFolder : Cannot process command because of one or more missing mandatory parameters: Path.');
      return null;
    }
    if (parsed.folderName === '*') {
      return dfs.listDfsnFolders(parsed.namespacePath).map(folderToPSObject) as PSValue;
    }
    const folder = dfs.getDfsnFolder(parsed.namespacePath, parsed.folderName);
    if (!folder) { ctx.emitError(`Get-DfsnFolder : No DFSN folder found for "${path}".`); return null; }
    return folderToPSObject(folder);
  }
}

// ── Get-DfsnFolderTarget ─────────────────────────────────────────────────

export class GetDfsnFolderTargetCmdlet implements ICmdlet {
  readonly name = 'get-dfsnfoldertarget';
  readonly aliases = [] as const;
  readonly parameters = ['Path'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'Get-DfsnFolderTarget');
    const path = pathOf(ctx);
    const parsed = parseNamespacePath(path);
    if (!parsed) {
      ctx.emitError('Get-DfsnFolderTarget : Cannot process command because of one or more missing mandatory parameters: Path.');
      return null;
    }
    const folder = dfs.getDfsnFolder(parsed.namespacePath, parsed.folderName);
    if (!folder) { ctx.emitError(`Get-DfsnFolderTarget : No DFSN folder found for "${path}".`); return null; }
    return folder.targets.map(t => ({
      Path: `${parsed.namespacePath}\\${parsed.folderName}`,
      TargetPath: `\\\\${t.serverAddress}\\${t.shareName}`,
      State: 'Online',
      ReferralPriorityClass: t.referralPriorityClass,
    } as Record<string, PSValue>)) as PSValue;
  }
}

// ── Set-DfsnFolderTarget ─────────────────────────────────────────────────

export class SetDfsnFolderTargetCmdlet implements ICmdlet {
  readonly name = 'set-dfsnfoldertarget';
  readonly aliases = [] as const;
  readonly parameters = ['Path', 'TargetPath', 'ReferralPriorityClass'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'Set-DfsnFolderTarget');
    const path = pathOf(ctx);
    const targetPath = psValueToString(ctx.named['targetpath'] ?? '');
    const priorityClass = ctx.named['referralpriorityclass'] !== undefined
      ? psValueToString(ctx.named['referralpriorityclass']) as DfsReferralPriorityClassInfo : undefined;
    const parsed = parseNamespacePath(path);
    const target = parseUncTarget(targetPath);
    if (!parsed || !target || !priorityClass) {
      ctx.emitError('Set-DfsnFolderTarget : Cannot process command because of one or more missing mandatory parameters: Path TargetPath ReferralPriorityClass.');
      return null;
    }
    const res = dfs.setDfsnFolderTargetPriority(parsed.namespacePath, parsed.folderName, target.serverAddress, priorityClass);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── New-DfsReplicationGroup ──────────────────────────────────────────────

export class NewDfsReplicationGroupCmdlet implements ICmdlet {
  readonly name = 'new-dfsreplicationgroup';
  readonly aliases = [] as const;
  readonly parameters = ['GroupName', 'ContentPath', 'Description'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'New-DfsReplicationGroup');
    const groupName = psValueToString(ctx.named['groupname'] ?? ctx.positional[0] ?? '');
    if (!groupName) {
      ctx.emitError('New-DfsReplicationGroup : Cannot process command because of one or more missing mandatory parameters: GroupName.');
      return null;
    }
    // Real signature has no -ContentPath (that belongs to Set-DfsrMembership) — but
    // this simulator's older single-server "this server's own membership" flow
    // (newGroup/sync, still exercised elsewhere) predates the admin-topology one
    // below, so both stay supported: -ContentPath present keeps the old behavior,
    // absent switches to the real admin-topology registration.
    const contentPath = ctx.named['contentpath'] !== undefined ? psValueToString(ctx.named['contentpath']) : '';
    if (contentPath) {
      const res = dfs.newDfsReplicationGroup(groupName, contentPath);
      if (!res.ok) { ctx.emitError(res.message); return null; }
      return null;
    }
    const description = ctx.named['description'] !== undefined ? psValueToString(ctx.named['description']) : '';
    const res = dfs.registerDfsrAdminGroup(groupName, description);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── Get-DfsReplicationGroup ──────────────────────────────────────────────

export class GetDfsReplicationGroupCmdlet implements ICmdlet {
  readonly name = 'get-dfsreplicationgroup';
  readonly aliases = [] as const;
  readonly parameters = ['GroupName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'Get-DfsReplicationGroup');
    const groupName = psValueToString(ctx.named['groupname'] ?? ctx.positional[0] ?? '');
    const g = dfs.getDfsrAdminGroup(groupName);
    if (!g) { ctx.emitError(`Get-DfsReplicationGroup : A replication group named "${groupName}" does not exist.`); return null; }
    return { GroupName: g.name, Description: g.description } as Record<string, PSValue>;
  }
}

// ── Add-DfsrMember ───────────────────────────────────────────────────────

export class AddDfsrMemberCmdlet implements ICmdlet {
  readonly name = 'add-dfsrmember';
  readonly aliases = [] as const;
  readonly parameters = ['GroupName', 'ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'Add-DfsrMember');
    const groupName = psValueToString(ctx.named['groupname'] ?? ctx.positional[0] ?? '');
    const computerNameArg = ctx.named['computername'];
    if (!groupName || computerNameArg === undefined) {
      ctx.emitError('Add-DfsrMember : Cannot process command because of one or more missing mandatory parameters: GroupName ComputerName.');
      return null;
    }
    const res = dfs.addDfsrMembers(groupName, stringArrayOf(computerNameArg));
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── Get-DfsrMember ───────────────────────────────────────────────────────

export class GetDfsrMemberCmdlet implements ICmdlet {
  readonly name = 'get-dfsrmember';
  readonly aliases = [] as const;
  readonly parameters = ['GroupName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'Get-DfsrMember');
    const groupName = psValueToString(ctx.named['groupname'] ?? ctx.positional[0] ?? '');
    return dfs.listDfsrMembers(groupName).map(c => ({ ComputerName: c }) as Record<string, PSValue>) as PSValue;
  }
}

// ── New-DfsReplicatedFolder ──────────────────────────────────────────────

export class NewDfsReplicatedFolderCmdlet implements ICmdlet {
  readonly name = 'new-dfsreplicatedfolder';
  readonly aliases = [] as const;
  readonly parameters = ['GroupName', 'FolderName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'New-DfsReplicatedFolder');
    const groupName = psValueToString(ctx.named['groupname'] ?? ctx.positional[0] ?? '');
    const folderName = psValueToString(ctx.named['foldername'] ?? '');
    if (!groupName || !folderName) {
      ctx.emitError('New-DfsReplicatedFolder : Cannot process command because of one or more missing mandatory parameters: GroupName FolderName.');
      return null;
    }
    const res = dfs.newDfsReplicatedFolderAdmin(groupName, folderName);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── Add-DfsrConnection ───────────────────────────────────────────────────

export class AddDfsrConnectionCmdlet implements ICmdlet {
  readonly name = 'add-dfsrconnection';
  readonly aliases = [] as const;
  readonly parameters = ['GroupName', 'SourceComputerName', 'DestinationComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'Add-DfsrConnection');
    const groupName = psValueToString(ctx.named['groupname'] ?? ctx.positional[0] ?? '');
    const source = psValueToString(ctx.named['sourcecomputername'] ?? '');
    const destination = psValueToString(ctx.named['destinationcomputername'] ?? '');
    if (!groupName || !source || !destination) {
      ctx.emitError('Add-DfsrConnection : Cannot process command because of one or more missing mandatory parameters: GroupName SourceComputerName DestinationComputerName.');
      return null;
    }
    const res = dfs.addDfsrConnection(groupName, source, destination);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── Set-DfsrMembership ───────────────────────────────────────────────────

export class SetDfsrMembershipCmdlet implements ICmdlet {
  readonly name = 'set-dfsrmembership';
  readonly aliases = [] as const;
  readonly parameters = ['GroupName', 'FolderName', 'ComputerName', 'ContentPath', 'PrimaryMember'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'Set-DfsrMembership');
    const groupName = psValueToString(ctx.named['groupname'] ?? ctx.positional[0] ?? '');
    const folderName = psValueToString(ctx.named['foldername'] ?? '');
    const computerName = psValueToString(ctx.named['computername'] ?? '');
    const contentPath = psValueToString(ctx.named['contentpath'] ?? '');
    const primaryMember = ctx.named['primarymember'] === true;
    if (!groupName || !folderName || !computerName || !contentPath) {
      ctx.emitError('Set-DfsrMembership : Cannot process command because of one or more missing mandatory parameters: GroupName FolderName ComputerName ContentPath.');
      return null;
    }
    const res = dfs.setDfsrMembership(groupName, folderName, computerName, contentPath, primaryMember);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── Get-DfsrMembership ───────────────────────────────────────────────────

export class GetDfsrMembershipCmdlet implements ICmdlet {
  readonly name = 'get-dfsrmembership';
  readonly aliases = [] as const;
  readonly parameters = ['GroupName', 'FolderName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'Get-DfsrMembership');
    const groupName = psValueToString(ctx.named['groupname'] ?? ctx.positional[0] ?? '');
    const folderName = psValueToString(ctx.named['foldername'] ?? '');
    return dfs.listDfsrMemberships(groupName, folderName).map(m => ({
      ComputerName: m.computerName, FolderName: m.folderName,
      ContentPath: m.contentPath, PrimaryMember: m.primaryMember,
    }) as Record<string, PSValue>) as PSValue;
  }
}

// ── Get-DfsrState ────────────────────────────────────────────────────────
// Diagnostic-only cmdlet — no admin-topology lookup required; real
// Get-DfsrState queries the DFSR service's own per-connection state on each
// named computer, which this simulator doesn't model beyond the pull-based
// Sync-DfsReplicationGroup cycle, so it honestly reports a static "Normal"
// state and the current time rather than fabricating a richer status.

export class GetDfsrStateCmdlet implements ICmdlet {
  readonly name = 'get-dfsrstate';
  readonly aliases = [] as const;
  readonly parameters = ['ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    requireDfs(ctx, 'Get-DfsrState');
    const computerNameArg = ctx.named['computername'] ?? ctx.positional[0];
    const names = computerNameArg !== undefined ? stringArrayOf(computerNameArg) : [];
    const now = new Date().toISOString();
    return names.map(n => ({ ComputerName: n, State: 'Normal', LastSyncTime: now }) as Record<string, PSValue>) as PSValue;
  }
}

// ── Sync-DfsReplicationGroup ─────────────────────────────────────────────

export class SyncDfsReplicationGroupCmdlet implements ICmdlet {
  readonly name = 'sync-dfsreplicationgroup';
  readonly aliases = [] as const;
  readonly parameters = ['GroupName', 'PartnerServer'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dfs = requireDfs(ctx, 'Sync-DfsReplicationGroup');
    const groupName = psValueToString(ctx.named['groupname'] ?? ctx.positional[0] ?? '');
    const partnerServer = psValueToString(ctx.named['partnerserver'] ?? '');
    if (!groupName || !partnerServer) {
      ctx.emitError('Sync-DfsReplicationGroup : Cannot process command because of one or more missing mandatory parameters: GroupName PartnerServer.');
      return null;
    }
    const res = dfs.syncDfsReplicationGroup(groupName, partnerServer);
    if (!res.ok) { ctx.emitError(`Sync-DfsReplicationGroup : ${res.error}`); return null; }
    return { FilesApplied: res.applied } as Record<string, PSValue>;
  }
}
