/**
 * VpnCmdlets — Add / Get / Set / Remove-VpnConnection.
 *
 * Provider: ctx.providers.vpn (IVpnProvider). State is shared with the
 * legacy PowerShellExecutor's `vpnConnections` map via the WindowsPSProviders
 * shared.vpn bag.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IVpnProvider, VpnConnectionInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

function requireVpn(ctx: CmdletContext): IVpnProvider {
  if (!ctx.providers.vpn) {
    throw new PSRuntimeError('VPN cmdlets are not recognized in this provider context');
  }
  return ctx.providers.vpn;
}

function toPSObject(c: VpnConnectionInfo): Record<string, PSValue> {
  return {
    Name:            c.name,
    ServerAddress:   c.serverAddress,
    TunnelType:      c.tunnelType,
    EncryptionLevel: c.encryptionLevel,
    AuthenticationMethod: c.authMethod,
    SplitTunneling:  c.splitTunneling,
    ConnectionStatus: c.connectionStatus,
  };
}

// ── Add-VpnConnection ────────────────────────────────────────────────────

export class AddVpnConnectionCmdlet implements ICmdlet {
  readonly name = 'add-vpnconnection';
  readonly displayName = 'Add-VpnConnection';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const vpn = requireVpn(ctx);
    const name           = psValueToString(ctx.named['name']           ?? '');
    const serverAddress  = psValueToString(ctx.named['serveraddress']  ?? '');
    if (!name || !serverAddress) {
      ctx.emitError('Add-VpnConnection requires -Name and -ServerAddress');
      return null;
    }
    vpn.addConnection({
      name,
      serverAddress,
      tunnelType:      ctx.named['tunneltype']            ? psValueToString(ctx.named['tunneltype'])            : 'Automatic',
      encryptionLevel: ctx.named['encryptionlevel']       ? psValueToString(ctx.named['encryptionlevel'])       : 'Required',
      authMethod:      ctx.named['authenticationmethod']  ? psValueToString(ctx.named['authenticationmethod'])  : 'MSChapv2',
      splitTunneling:  ctx.named['splittunneling'] === true,
      destinationPrefixes: [],
      connectionStatus: 'Disconnected',
    });
    return null;
  }
}

// ── Get-VpnConnection ────────────────────────────────────────────────────

export class GetVpnConnectionCmdlet implements ICmdlet {
  readonly name = 'get-vpnconnection';
  readonly displayName = 'Get-VpnConnection';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const vpn = requireVpn(ctx);
    const name = ctx.named['name'] ?? ctx.positional[0];
    if (name === undefined || name === null || name === '') {
      return vpn.listConnections().map(toPSObject) as PSValue;
    }
    const filter = psValueToString(name);
    const found  = vpn.getConnection(filter);
    if (!found) {
      ctx.emitError(`Cannot find VPN connection '${filter}'.`);
      return null;
    }
    return toPSObject(found);
  }
}

// ── Set-VpnConnection ────────────────────────────────────────────────────

export class SetVpnConnectionCmdlet implements ICmdlet {
  readonly name = 'set-vpnconnection';
  readonly displayName = 'Set-VpnConnection';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const vpn = requireVpn(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('Set-VpnConnection requires -Name'); return null; }

    const opts: Partial<Omit<VpnConnectionInfo, 'name'>> = {};
    if (ctx.named['serveraddress']        !== undefined) opts.serverAddress   = psValueToString(ctx.named['serveraddress']);
    if (ctx.named['tunneltype']           !== undefined) opts.tunnelType      = psValueToString(ctx.named['tunneltype']);
    if (ctx.named['encryptionlevel']      !== undefined) opts.encryptionLevel = psValueToString(ctx.named['encryptionlevel']);
    if (ctx.named['authenticationmethod'] !== undefined) opts.authMethod     = psValueToString(ctx.named['authenticationmethod']);
    if (ctx.named['splittunneling']       !== undefined) opts.splitTunneling = ctx.named['splittunneling'] === true;

    const msg = vpn.setConnection(name, opts);
    if (msg) ctx.emitError(msg);
    return null;
  }
}

// ── Add-VpnConnectionRoute ───────────────────────────────────────────────

export class AddVpnConnectionRouteCmdlet implements ICmdlet {
  readonly name = 'add-vpnconnectionroute';
  readonly displayName = 'Add-VpnConnectionRoute';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const vpn = requireVpn(ctx);
    const name = psValueToString(ctx.named['connectionname'] ?? ctx.named['name'] ?? '');
    const prefix = psValueToString(ctx.named['destinationprefix'] ?? '');
    if (!name || !prefix) {
      ctx.emitError('Add-VpnConnectionRoute requires -ConnectionName and -DestinationPrefix');
      return null;
    }
    const msg = vpn.addConnectionRoute(name, prefix);
    if (msg) ctx.emitError(msg);
    return null;
  }
}

// ── Connect-VpnConnection ────────────────────────────────────────────────

export class ConnectVpnConnectionCmdlet implements ICmdlet {
  readonly name = 'connect-vpnconnection';
  readonly displayName = 'Connect-VpnConnection';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const vpn = requireVpn(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('Connect-VpnConnection requires -Name'); return null; }
    const msg = vpn.connect(name);
    if (msg) ctx.emitError(msg);
    return null;
  }
}

// ── Disconnect-VpnConnection ─────────────────────────────────────────────

export class DisconnectVpnConnectionCmdlet implements ICmdlet {
  readonly name = 'disconnect-vpnconnection';
  readonly displayName = 'Disconnect-VpnConnection';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const vpn = requireVpn(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('Disconnect-VpnConnection requires -Name'); return null; }
    const msg = vpn.disconnect(name);
    if (msg) ctx.emitError(msg);
    return null;
  }
}

// ── Remove-VpnConnection ─────────────────────────────────────────────────

export class RemoveVpnConnectionCmdlet implements ICmdlet {
  readonly name = 'remove-vpnconnection';
  readonly displayName = 'Remove-VpnConnection';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const vpn = requireVpn(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('Remove-VpnConnection requires -Name'); return null; }
    const msg = vpn.removeConnection(name);
    if (msg) ctx.emitError(msg);
    return null;
  }
}
