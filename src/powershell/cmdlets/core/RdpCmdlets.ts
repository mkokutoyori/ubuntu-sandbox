/**
 * RdpCmdlets — Remote Desktop cmdlets (PRD-Windows-Server-Advanced.md §5
 * P17, §2.1.16): `Enable-RemoteDesktop`/`Disable-RemoteDesktop` toggle the
 * TCP/3389 listener; `Get-RDUserSession` mirrors `query session`'s own
 * session-table introspection. No graphical content — a real session
 * state only (`sessionId`/`userName`/`state`/`clientAddress`).
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IRdpProvider, RdpSessionInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function requireRdp(ctx: CmdletContext, cmdletName: string): IRdpProvider {
  if (!ctx.providers.rdp) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  }
  return ctx.providers.rdp;
}

function sessionToPSObject(s: RdpSessionInfo): Record<string, PSValue> {
  return { SessionId: s.sessionId, UserName: s.userName, SessionState: s.state, ClientIPAddress: s.clientAddress };
}

export class EnableRemoteDesktopCmdlet implements ICmdlet {
  readonly name = 'enable-remotedesktop';
  readonly aliases = [] as const;
  readonly parameters = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const rdp = requireRdp(ctx, 'Enable-RemoteDesktop');
    rdp.enable();
    return null;
  }
}

export class DisableRemoteDesktopCmdlet implements ICmdlet {
  readonly name = 'disable-remotedesktop';
  readonly aliases = [] as const;
  readonly parameters = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const rdp = requireRdp(ctx, 'Disable-RemoteDesktop');
    rdp.disable();
    return null;
  }
}

export class GetRDUserSessionCmdlet implements ICmdlet {
  readonly name = 'get-rdusersession';
  readonly aliases = [] as const;
  readonly parameters = [] as const;
  readonly displayName = 'Get-RDUserSession';

  execute(ctx: CmdletContext): PSValue {
    const rdp = requireRdp(ctx, 'Get-RDUserSession');
    return rdp.listSessions().map(sessionToPSObject);
  }
}

export class LogoffRdSessionCmdlet implements ICmdlet {
  readonly name = 'invoke-rdusersessionlogoff';
  readonly aliases = [] as const;
  readonly parameters = ['Id'] as const;
  readonly displayName = 'Invoke-RDUserSessionLogoff';

  execute(ctx: CmdletContext): PSValue {
    const rdp = requireRdp(ctx, 'Invoke-RDUserSessionLogoff');
    const id = Number(psValueToString(ctx.named['id'] ?? ctx.positional[0] ?? ''));
    if (Number.isNaN(id)) {
      ctx.emitError('Invoke-RDUserSessionLogoff : Cannot process command because of one or more missing mandatory parameters: Id.');
      return null;
    }
    const res = rdp.logoff(id);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}
