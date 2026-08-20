import { parsePSArgs } from './psArgs';

export interface FirewallRule {
  name: string;
  displayName: string;
  enabled: boolean;
  action: string;
  direction: string;
  protocol: string;
  localPort: string;
  remotePort: string;
  description: string;
}

export interface PSFirewallContext {
  dynamicFirewallRules: Map<string, FirewallRule>;
}

const unquote = (v: string | undefined): string => (v ?? '').replace(/^["']|["']$/g, '');

const STATIC_RULES: ReadonlyArray<Pick<FirewallRule, 'name' | 'displayName' | 'enabled' | 'action' | 'direction'>> = [
  { name: 'CoreNet-DHCP-In',      displayName: 'DHCP (UDP-In)',              enabled: true,  action: 'Allow', direction: 'Inbound'  },
  { name: 'CoreNet-DHCP-Out',     displayName: 'DHCP (UDP-Out)',             enabled: true,  action: 'Allow', direction: 'Outbound' },
  { name: 'CoreNet-DNS-Out',      displayName: 'DNS (UDP-Out)',              enabled: true,  action: 'Allow', direction: 'Outbound' },
  { name: 'FPS-ICMP4-ERQ-In',     displayName: 'File and Printer Sharing...', enabled: true, action: 'Allow', direction: 'Inbound'  },
  { name: 'RemoteDesktop-In-TCP', displayName: 'Remote Desktop - User Mode', enabled: false, action: 'Allow', direction: 'Inbound'  },
  { name: 'WinRM-HTTP-In-TCP',    displayName: 'Windows Remote Management',  enabled: false, action: 'Allow', direction: 'Inbound'  },
  { name: 'BlockTelemetry',       displayName: 'Block Windows Telemetry',    enabled: true,  action: 'Block', direction: 'Outbound' },
];

export function psNewNetFirewallRule(ctx: PSFirewallContext, args: string[]): string {
  const params = parsePSArgs(args);
  const displayName = unquote(params.get('displayname'));
  const name = unquote(params.get('name')) || displayName.replace(/\s+/g, '-');
  const direction = unquote(params.get('direction')) || 'Inbound';
  const protocol = unquote(params.get('protocol')) || 'Any';
  const localPort = unquote(params.get('localport'));
  const remotePort = unquote(params.get('remoteport'));
  const action = unquote(params.get('action')) || 'Allow';
  const description = unquote(params.get('description'));

  if (!displayName && !name) return `New-NetFirewallRule : -DisplayName or -Name is required.`;

  const key = displayName.toLowerCase() || name.toLowerCase();
  ctx.dynamicFirewallRules.set(key, {
    name, displayName, enabled: true, action, direction, protocol, localPort, remotePort, description,
  });

  return [
    `Name                  : ${name}`,
    `DisplayName           : ${displayName}`,
    `Description           : ${description}`,
    `Direction             : ${direction}`,
    `Action                : ${action}`,
    `Enabled               : True`,
    `Protocol              : ${protocol}`,
    `LocalPort             : ${localPort}`,
    `RemotePort            : ${remotePort}`,
  ].join('\n');
}

export function psSetNetFirewallRule(ctx: PSFirewallContext, args: string[]): string {
  const params = parsePSArgs(args);
  const displayName = unquote(params.get('displayname'));
  const name = unquote(params.get('name'));
  const key = (displayName || name).toLowerCase();

  const rule = ctx.dynamicFirewallRules.get(key);
  if (!rule) return `Set-NetFirewallRule : No MSFT_NetFirewallRule objects found with property 'DisplayName' equal to '${displayName || name}'.`;

  if (params.has('action')) rule.action = unquote(params.get('action'));
  if (params.has('direction')) rule.direction = unquote(params.get('direction'));
  if (params.has('enabled')) rule.enabled = (params.get('enabled') ?? '').toLowerCase() !== 'false';
  return '';
}

export function psToggleNetFirewallRule(ctx: PSFirewallContext, args: string[], enable: boolean): string {
  const params = parsePSArgs(args);
  const displayName = unquote(params.get('displayname'));
  const name = unquote(params.get('name'));
  const key = (displayName || name).toLowerCase();

  const rule = ctx.dynamicFirewallRules.get(key);
  if (!rule) return '';
  rule.enabled = enable;
  return '';
}

export function psRemoveNetFirewallRule(ctx: PSFirewallContext, args: string[]): string {
  const params = parsePSArgs(args);
  const key = (unquote(params.get('displayname')) || unquote(params.get('name'))).toLowerCase();
  ctx.dynamicFirewallRules.delete(key);
  return '';
}

export function psGetNetFirewallRule(ctx: PSFirewallContext, args: string[]): string {
  const allRules = [
    ...STATIC_RULES.map(r => ({ ...r })),
    ...[...ctx.dynamicFirewallRules.values()].map(r => ({
      name: r.name, displayName: r.displayName, enabled: r.enabled, action: r.action, direction: r.direction,
    })),
  ];

  const params = parsePSArgs(args);
  const nameFilter = unquote(params.get('name')).toLowerCase();
  const dnFilter = unquote(params.get('displayname')).toLowerCase();

  let filtered = allRules;
  if (nameFilter) filtered = filtered.filter(r => r.name.toLowerCase() === nameFilter || r.name.toLowerCase().includes(nameFilter));
  if (dnFilter) filtered = filtered.filter(r => r.displayName.toLowerCase() === dnFilter || r.displayName.toLowerCase().includes(dnFilter));

  if (filtered.length === 0) return '';

  const header = [
    '',
    'Name                  DisplayName                  Enabled Action Direction',
    '----                  -----------                  ------- ------ ---------',
  ];
  const rows = filtered.map(r =>
    `${r.name.padEnd(22)}${r.displayName.substring(0, 29).padEnd(29)}${(r.enabled ? 'True' : 'False').padEnd(8)}${r.action.padEnd(7)}${r.direction}`
  );
  return [...header, ...rows].join('\n');
}
