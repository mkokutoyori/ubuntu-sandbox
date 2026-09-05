/**
 * WsusCmdlets — WSUS minimal (PRD-Windows-Server-Advanced.md §5 P19,
 * §2.1.18): `Get-WsusUpdate`/`Approve-WsusUpdate` manage the server-side
 * catalog and per-deployment-group approvals; `Set-WUSettings`/
 * `Get-WindowsUpdate` are the client-side cmdlets that redirect a machine
 * at a WSUS server and read back what's approved for its group.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IWsusProvider, IWindowsUpdateProvider, WsusUpdateInfo, WsusApprovalActionInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function requireWsus(ctx: CmdletContext, cmdletName: string): IWsusProvider {
  if (!ctx.providers.wsus) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  }
  return ctx.providers.wsus;
}

function requireWindowsUpdate(ctx: CmdletContext, cmdletName: string): IWindowsUpdateProvider {
  if (!ctx.providers.windowsUpdate) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  }
  return ctx.providers.windowsUpdate;
}

function updateToPSObject(u: WsusUpdateInfo): Record<string, PSValue> {
  return { KB: u.kbId, Title: u.title, Category: u.category, Severity: u.severity };
}

// ── Get-WsusUpdate ───────────────────────────────────────────────────────

export class GetWsusUpdateCmdlet implements ICmdlet {
  readonly name = 'get-wsusupdate';
  readonly aliases = [] as const;
  readonly parameters = [] as const;
  readonly displayName = 'Get-WsusUpdate';

  execute(ctx: CmdletContext): PSValue {
    const wsus = requireWsus(ctx, 'Get-WsusUpdate');
    return wsus.listCatalog().map(updateToPSObject);
  }
}

// ── Approve-WsusUpdate ───────────────────────────────────────────────────

export class ApproveWsusUpdateCmdlet implements ICmdlet {
  readonly name = 'approve-wsusupdate';
  readonly aliases = [] as const;
  readonly parameters = ['Updates', 'TargetGroupName', 'Action'] as const;
  readonly displayName = 'Approve-WsusUpdate';

  execute(ctx: CmdletContext): PSValue {
    const wsus = requireWsus(ctx, 'Approve-WsusUpdate');
    const kbId = psValueToString(ctx.named['updates'] ?? ctx.positional[0] ?? '');
    const targetGroup = psValueToString(ctx.named['targetgroupname'] ?? '');
    const action = psValueToString(ctx.named['action'] ?? '') as WsusApprovalActionInfo;
    if (!kbId || !targetGroup || (action !== 'Install' && action !== 'Decline')) {
      ctx.emitError('Approve-WsusUpdate : Cannot process command because of one or more missing mandatory parameters: Updates TargetGroupName Action.');
      return null;
    }
    const res = wsus.approveUpdate(kbId, targetGroup, action);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── Set-WUSettings ───────────────────────────────────────────────────────

export class SetWUSettingsCmdlet implements ICmdlet {
  readonly name = 'set-wusettings';
  readonly aliases = [] as const;
  readonly parameters = ['WUServer', 'TargetGroup'] as const;
  readonly displayName = 'Set-WUSettings';

  execute(ctx: CmdletContext): PSValue {
    const wu = requireWindowsUpdate(ctx, 'Set-WUSettings');
    const wuServer = psValueToString(ctx.named['wuserver'] ?? '');
    const targetGroup = ctx.named['targetgroup'] !== undefined ? psValueToString(ctx.named['targetgroup']) : undefined;
    if (!wuServer) {
      ctx.emitError('Set-WUSettings : Cannot process command because of one or more missing mandatory parameters: WUServer.');
      return null;
    }
    wu.setWuSettings(wuServer, targetGroup);
    return null;
  }
}

// ── Get-WindowsUpdate ────────────────────────────────────────────────────

export class GetWindowsUpdateCmdlet implements ICmdlet {
  readonly name = 'get-windowsupdate';
  readonly aliases = [] as const;
  readonly parameters = [] as const;
  readonly displayName = 'Get-WindowsUpdate';

  execute(ctx: CmdletContext): PSValue {
    const wu = requireWindowsUpdate(ctx, 'Get-WindowsUpdate');
    return wu.getWindowsUpdates().map(updateToPSObject);
  }
}
