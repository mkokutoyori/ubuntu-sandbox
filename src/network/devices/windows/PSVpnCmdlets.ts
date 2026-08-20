import type { VpnConnectionInfo } from '@/powershell/providers/PSProviders';
import { parsePSArgs } from './psArgs';

export interface PSVpnContext {
  vpnConnections: Map<string, VpnConnectionInfo>;
}

const unquote = (v: string | undefined): string => (v ?? '').replace(/^["']|["']$/g, '');

export function psAddVpnConnection(ctx: PSVpnContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = unquote(params.get('name'));
  if (!name) return `Add-VpnConnection : -Name is required.`;

  ctx.vpnConnections.set(name.toLowerCase(), {
    name,
    serverAddress: unquote(params.get('serveraddress')),
    tunnelType: unquote(params.get('tunneltype')) || 'Automatic',
    encryptionLevel: unquote(params.get('encryptionlevel')) || 'Optional',
    authMethod: unquote(params.get('authenticationmethod')) || 'MSChapv2',
    splitTunneling: false,
    destinationPrefixes: [],
    connectionStatus: 'Disconnected',
  });
  return '';
}

export function psGetVpnConnection(ctx: PSVpnContext, args: string[]): string {
  const nameFilter = unquote(parsePSArgs(args).get('name')).toLowerCase();
  const results = nameFilter
    ? [...ctx.vpnConnections.values()].filter(v => v.name.toLowerCase() === nameFilter)
    : [...ctx.vpnConnections.values()];

  if (results.length === 0) return '';

  return results.map(v => [
    `Name                  : ${v.name}`,
    `ServerAddress         : ${v.serverAddress}`,
    `TunnelType            : ${v.tunnelType}`,
    `EncryptionLevel       : ${v.encryptionLevel}`,
    `AuthenticationMethod  : ${v.authMethod}`,
    `ConnectionStatus      : ${v.connectionStatus}`,
  ].join('\n')).join('\n\n');
}

export function psSetVpnConnection(ctx: PSVpnContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = unquote(params.get('name'));
  if (!name) return '';

  const key = name.toLowerCase();
  const existing = ctx.vpnConnections.get(key) ?? {
    name, serverAddress: '', tunnelType: 'Automatic', encryptionLevel: 'Optional', authMethod: 'MSChapv2',
    splitTunneling: false, destinationPrefixes: [], connectionStatus: 'Disconnected' as const,
  };

  if (params.has('serveraddress')) existing.serverAddress = unquote(params.get('serveraddress'));
  if (params.has('tunneltype')) existing.tunnelType = unquote(params.get('tunneltype'));
  if (params.has('encryptionlevel')) existing.encryptionLevel = unquote(params.get('encryptionlevel'));
  ctx.vpnConnections.set(key, existing);
  return '';
}

export function psRemoveVpnConnection(ctx: PSVpnContext, args: string[]): string {
  const name = unquote(parsePSArgs(args).get('name'));
  ctx.vpnConnections.delete(name.toLowerCase());
  return '';
}
