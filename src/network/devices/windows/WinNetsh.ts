/**
 * Windows NETSH command — network shell for configuration.
 *
 * Supported (non-interactive, command-line mode):
 *   netsh /?                                             — usage help
 *   netsh interface ip set address "name" static ...     — configure static IP
 *   netsh interface ip set address "name" dhcp           — switch to DHCP
 *   netsh interface ip set dns "name" static <ip>        — set primary DNS
 *   netsh interface ip set dns "name" dhcp               — set DNS to DHCP
 *   netsh interface ip add dns "name" <ip>               — add DNS server
 *   netsh interface ip add route <prefix>/<len> "name" <nexthop> — add route
 *   netsh interface ip delete dns "name" <ip>            — remove DNS server
 *   netsh interface ip delete route <prefix>/<len> "name" — remove route
 *   netsh interface ip delete address "name" addr=<ip>   — remove IP from interface
 *   netsh interface ip show config                       — show IP config
 *   netsh interface ip show addresses                    — show addresses
 *   netsh interface ip show dns                          — show DNS servers
 *   netsh interface ip show route                        — show routing table
 *   netsh interface show interface                       — show interface table
 *   netsh interface set interface "name" admin=enable/disable — enable/disable
 *   netsh int ip reset [logfile]                         — reset TCP/IP stack
 *   netsh winsock reset                                  — reset Winsock catalog
 *   netsh show alias                                     — list aliases
 *   netsh show helper                                    — list helpers
 *   netsh <context> ?                                    — sub-context help
 */

import type { WinCommandContext } from './WinCommandExecutor';
import { IPAddress, SubnetMask } from '../../core/types';

// ─── Help text matching real Windows netsh ─────────────────────────

const NETSH_USAGE = `Usage: netsh [-a AliasFile] [-c Context] [-r RemoteMachine] [-u [DomainName\\]UserName] [-p Password | *]
             [Command | -f ScriptFile]

The following commands are available:

Commands in this context:
?              - Displays a list of commands.
add            - Adds a configuration entry to a list of entries.
advfirewall    - Changes to the \`netsh advfirewall' context.
branchcache    - Changes to the \`netsh branchcache' context.
bridge         - Changes to the \`netsh bridge' context.
delete         - Deletes a configuration entry from a list of entries.
dhcpclient     - Changes to the \`netsh dhcpclient' context.
dnsclient      - Changes to the \`netsh dnsclient' context.
dump           - Displays a configuration script.
exec           - Runs a script file.
firewall       - Changes to the \`netsh firewall' context.
help           - Displays a list of commands.
http           - Changes to the \`netsh http' context.
interface      - Changes to the \`netsh interface' context.
ipsec          - Changes to the \`netsh ipsec' context.
lan            - Changes to the \`netsh lan' context.
mbn            - Changes to the \`netsh mbn' context.
namespace      - Changes to the \`netsh namespace' context.
netio          - Changes to the \`netsh netio' context.
nlm            - Changes to the \`netsh nlm' context.
p2p            - Changes to the \`netsh p2p' context.
ras            - Changes to the \`netsh ras' context.
rpc            - Changes to the \`netsh rpc' context.
set            - Updates configuration settings.
show           - Displays information.
trace          - Changes to the \`netsh trace' context.
wcn            - Changes to the \`netsh wcn' context.
wfp            - Changes to the \`netsh wfp' context.
winhttp        - Changes to the \`netsh winhttp' context.
winsock        - Changes to the \`netsh winsock' context.
wlan           - Changes to the \`netsh wlan' context.

The following sub-contexts are available:
 advfirewall branchcache bridge dhcpclient dnsclient firewall http interface ipsec lan mbn namespace netio nlm p2p ras rpc trace wcn wfp winhttp winsock wlan

To view help for a command, type the command, followed by a space, and then
 type ?.`;

const NETSH_INTERFACE_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
6to4           - Changes to the \`netsh interface 6to4' context.
dump           - Displays a configuration script.
help           - Displays a list of commands.
httpstunnel    - Changes to the \`netsh interface httpstunnel' context.
ip             - Changes to the \`netsh interface ip' context.
ipv4           - Changes to the \`netsh interface ipv4' context.
ipv6           - Changes to the \`netsh interface ipv6' context.
isatap         - Changes to the \`netsh interface isatap' context.
portproxy      - Changes to the \`netsh interface portproxy' context.
set            - Sets configuration information.
show           - Displays information.
tcp            - Changes to the \`netsh interface tcp' context.
teredo         - Changes to the \`netsh interface teredo' context.
udp            - Changes to the \`netsh interface udp' context.

The following sub-contexts are available:
 6to4 httpstunnel ip ipv4 ipv6 isatap portproxy tcp teredo udp

To view help for a command, type the command, followed by a space, and then
 type ?.`;

const NETSH_INTERFACE_IP_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
add            - Adds a configuration entry to a table.
delete         - Deletes a configuration entry from a table.
dump           - Displays a configuration script.
help           - Displays a list of commands.
set            - Sets configuration information.
show           - Displays information.

To view help for a command, type the command, followed by a space, and then
 type ?.`;

const NETSH_SHOW_HELP = `The following commands are available:

Commands in this context:
show alias     - Lists all defined aliases.
show helper    - Lists all the top-level helpers.`;

// Sub-context stubs for unsupported contexts
const SUB_CONTEXT_STUB: Record<string, string> = {
  advfirewall: 'advfirewall',
  branchcache: 'branchcache',
  bridge: 'bridge',
  dhcpclient: 'dhcpclient',
  dnsclient: 'dnsclient',
  firewall: 'firewall',
  http: 'http',
  ipsec: 'ipsec',
  lan: 'lan',
  mbn: 'mbn',
  namespace: 'namespace',
  netio: 'netio',
  nlm: 'nlm',
  ras: 'ras',
  rpc: 'rpc',
  trace: 'trace',
  wcn: 'wcn',
  wfp: 'wfp',
  winhttp: 'winhttp',
  wlan: 'wlan',
};

const P2P_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
dump           - Displays a configuration script.
group          - Changes to the \`netsh p2p group' context.
help           - Displays a list of commands.
idmgr          - Changes to the \`netsh p2p idmgr' context.
pnrp           - Changes to the \`netsh p2p pnrp' context.

The following sub-contexts are available:
 group idmgr pnrp

To view help for a command, type the command, followed by a space, and then
 type ?.`;

export function cmdNetsh(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0) {
    return NETSH_USAGE;
  }

  const joined = args.join(' ');
  const joinedLower = joined.toLowerCase();

  // netsh /? or netsh ?  or netsh help
  if (args[0] === '/?' || args[0] === '?' || args[0].toLowerCase() === 'help') {
    return NETSH_USAGE;
  }

  // netsh show ...
  if (args[0].toLowerCase() === 'show') {
    return handleNetshShow(args.slice(1));
  }

  // netsh winsock reset
  if (joinedLower.match(/winsock\s+reset/)) {
    ctx.addDHCPEvent('RESET', 'Winsock catalog has been reset');
    return '\nWinsock Catalog successfully reset.\nYou must restart the computer in order to complete the reset.';
  }

  // netsh int[erface] ip reset [logfile]
  if (joinedLower.match(/int(?:erface)?\s+ip\s+reset/i)) {
    ctx.resetStack();
    ctx.addDHCPEvent('RESET', 'TCP/IP stack has been reset');
    return 'Resetting Interface, OK!\nRestart the computer to complete this action.';
  }

  // netsh interface ...
  if (args[0].toLowerCase() === 'interface' || args[0].toLowerCase() === 'int') {
    return handleNetshInterface(ctx, args.slice(1));
  }

  // netsh p2p ?
  if (args[0].toLowerCase() === 'p2p') {
    return P2P_HELP;
  }

  // netsh winsock ?
  if (args[0].toLowerCase() === 'winsock') {
    if (args.length === 1 || args[1] === '?' || args[1] === '/?') {
      return `The following commands are available:\n\nCommands in this context:\n?              - Displays a list of commands.\naudit          - Displays a list of Winsock LSPs that have been installed and removed.\nhelp           - Displays a list of commands.\nremove         - Removes a Winsock LSP from the system.\nreset          - Resets the Winsock Catalog to a clean state.\nset            - Sets Winsock options.\nshow           - Displays information.\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
    }
  }

  // Sub-context stubs
  if (SUB_CONTEXT_STUB[args[0].toLowerCase()]) {
    return `The following commands are available:\n\nCommands in this context:\n?              - Displays a list of commands.\ndump           - Displays a configuration script.\nhelp           - Displays a list of commands.\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
  }

  return NETSH_USAGE;
}

// ─── netsh show ─────────────────────────────────────────────────────

function handleNetshShow(args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?') {
    return NETSH_SHOW_HELP;
  }
  if (args[0].toLowerCase() === 'alias') {
    if (args[1] === '/?' || args[1] === '?') {
      return 'Usage: show alias\n\nRemarks:\n       Lists all defined aliases.';
    }
    return ''; // No aliases defined
  }
  if (args[0].toLowerCase() === 'helper') {
    return 'Top-level helpers:\n  advfirewall  branchcache  bridge  dhcpclient  dnsclient\n  firewall  http  interface  ipsec  lan  mbn  namespace\n  netio  nlm  p2p  ras  rpc  trace  wcn  wfp  winhttp\n  winsock  wlan';
  }
  return NETSH_SHOW_HELP;
}

// ─── netsh interface ────────────────────────────────────────────────

function handleNetshInterface(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?') {
    return NETSH_INTERFACE_HELP;
  }

  const sub = args[0].toLowerCase();

  // netsh interface ip ... / netsh interface ipv4 ...
  if (sub === 'ip' || sub === 'ipv4') {
    return handleNetshInterfaceIp(ctx, args.slice(1));
  }

  // netsh interface show interface
  if (sub === 'show') {
    return handleNetshInterfaceShow(ctx, args.slice(1));
  }

  // netsh interface set interface "name" admin=enable/disable
  if (sub === 'set') {
    return handleNetshInterfaceSet(ctx, args.slice(1));
  }

  return NETSH_INTERFACE_HELP;
}

// ─── netsh interface show interface ─────────────────────────────────

function handleNetshInterfaceShow(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?') {
    return `The following commands are available:\n\nCommands in this context:\nshow interface - Shows interface table.`;
  }

  if (args[0].toLowerCase() !== 'interface') {
    return `The following commands are available:\n\nCommands in this context:\nshow interface - Shows interface table.`;
  }

  // Build interface table
  const lines: string[] = [];
  lines.push('');
  lines.push('Admin State    State          Type             Interface Name');
  lines.push('-------------------------------------------------------------------------');

  for (const [name, port] of ctx.ports) {
    const adminEnabled = ctx.getInterfaceAdmin(name);
    const adminState = adminEnabled ? 'Enabled' : 'Disabled';
    const isConnected = port.isConnected();
    const state = !adminEnabled ? 'Disconnected' : (isConnected ? 'Connected' : 'Disconnected');
    const displayName = name.replace(/^eth/, 'Ethernet ');
    lines.push(
      `${adminState.padEnd(15)}${state.padEnd(15)}${'Dedicated'.padEnd(17)}${displayName}`
    );
  }

  lines.push('');
  return lines.join('\n');
}

// ─── netsh interface set interface ──────────────────────────────────

function handleNetshInterfaceSet(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?') {
    return 'Usage: set interface [name=]<string> [[admin=]enable|disable]';
  }

  if (args[0].toLowerCase() !== 'interface') {
    return 'Usage: set interface [name=]<string> [[admin=]enable|disable]';
  }

  const joined = args.slice(1).join(' ');

  // Parse: "Ethernet 0" admin=enable OR name="Ethernet 0" admin=disable
  const match = joined.match(/"([^"]+)"\s+admin=(enable|disable)/i)
    || joined.match(/(.+?)\s+admin=(enable|disable)/i);

  if (!match) {
    return 'Usage: set interface [name=]<string> [[admin=]enable|disable]';
  }

  const ifName = match[1].replace(/^name=/, '');
  const enable = match[2].toLowerCase() === 'enable';

  const portName = resolveAdapterName(ifName, ctx.ports);
  const port = ctx.ports.get(portName);
  if (!port) return `The interface "${ifName}" was not found.`;

  ctx.setInterfaceAdmin(portName, enable);
  return 'Ok.';
}

// ─── netsh interface ip ─────────────────────────────────────────────

function handleNetshInterfaceIp(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?') {
    return NETSH_INTERFACE_IP_HELP;
  }

  const sub = args[0].toLowerCase();

  if (sub === 'show') {
    return handleInterfaceIpShow(ctx, args.slice(1));
  }

  if (sub === 'set') {
    return handleInterfaceIpSet(ctx, args.slice(1).join(' '));
  }

  if (sub === 'add') {
    return handleInterfaceIpAdd(ctx, args.slice(1).join(' '));
  }

  if (sub === 'delete') {
    return handleInterfaceIpDelete(ctx, args.slice(1).join(' '));
  }

  if (sub === 'reset') {
    ctx.resetStack();
    ctx.addDHCPEvent('RESET', 'TCP/IP stack has been reset');
    return 'Resetting Interface, OK!\nRestart the computer to complete this action.';
  }

  return NETSH_INTERFACE_IP_HELP;
}

// ─── netsh interface ip show ────────────────────────────────────────

function handleInterfaceIpShow(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?') {
    return `The following commands are available:\n\nCommands in this context:\nshow addresses - Shows IP address configurations.\nshow config    - Displays IP address and additional information.\nshow dns       - Displays the DNS server addresses.\nshow ipstats   - Displays IP statistics.\nshow joins     - Displays multicast groups joined.\nshow offload   - Displays the offload information.\nshow route     - Displays route table entries.\nshow subinterfaces - Shows subinterface parameters.\nshow tcpstats  - Displays TCP statistics.\nshow udpstats  - Displays UDP statistics.\nshow wins      - Displays the WINS server addresses.`;
  }

  const sub = args[0].toLowerCase();

  if (sub === 'config' || sub === 'addresses') {
    return handleShowConfig(ctx);
  }

  if (sub === 'dns') {
    return handleShowDns(ctx);
  }

  if (sub === 'route') {
    return handleShowRoute(ctx);
  }

  return 'The syntax supplied for this command is not valid. Check help for the correct syntax.';
}

function handleShowConfig(ctx: WinCommandContext): string {
  const lines: string[] = [];
  for (const [name, port] of ctx.ports) {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const displayName = name.replace(/^eth/, 'Ethernet ');
    const isDHCP = ctx.isDHCPConfigured(name);

    lines.push(`Configuration for interface "${displayName}"`);
    lines.push(`    DHCP enabled:                         ${isDHCP ? 'Yes' : 'No'}`);
    if (ip) {
      lines.push(`    IP Address:                           ${ip}`);
      lines.push(`    Subnet Prefix:                        ${ip}/${mask?.toCIDR() || 24} (mask ${mask || '255.255.255.0'})`);
    }
    if (ctx.defaultGateway) {
      lines.push(`    Default Gateway:                      ${ctx.defaultGateway}`);
    }
    lines.push(`    Gateway Metric:                       0`);
    lines.push(`    InterfaceMetric:                      25`);
    lines.push('');
  }
  return lines.join('\n');
}

function handleShowDns(ctx: WinCommandContext): string {
  const lines: string[] = [];
  for (const [name] of ctx.ports) {
    const displayName = name.replace(/^eth/, 'Ethernet ');
    const dnsMode = ctx.getDnsMode(name);
    const servers = ctx.getDnsServers(name);

    lines.push(`Configuration for interface "${displayName}"`);
    if (dnsMode === 'dhcp') {
      lines.push(`    DNS servers configured through DHCP`);
    }
    if (servers.length > 0) {
      lines.push(`    Statically Configured DNS Servers:    ${servers[0]}`);
      for (let i = 1; i < servers.length; i++) {
        lines.push(`                                          ${servers[i]}`);
      }
    } else if (dnsMode === 'static') {
      lines.push(`    Statically Configured DNS Servers:    None`);
    } else {
      lines.push(`    DNS Servers:                          None`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function handleShowRoute(ctx: WinCommandContext): string {
  const routes = ctx.getRoutingTable();
  const lines: string[] = [];
  lines.push('');
  lines.push('Publish  Type      Met  Prefix                    NextHop/Interface');
  lines.push('---------  --------  ---  ------------------------  -------------------------------------------');

  for (const r of routes) {
    const prefix = `${r.network}/${r.mask.toCIDR()}`;
    const nextHop = r.nextHop || 'On-link';
    lines.push(
      `No       ${r.type.padEnd(10)}${String(r.metric).padEnd(5)}${prefix.padEnd(26)}${nextHop}`
    );
  }

  lines.push('');
  return lines.join('\n');
}

// ─── netsh interface ip set ─────────────────────────────────────────

function handleInterfaceIpSet(ctx: WinCommandContext, joined: string): string {
  const lower = joined.toLowerCase();

  // Determine sub-target: dns or address
  if (lower.startsWith('dns')) {
    if (lower.match(/dns\s+.*\s+dhcp/)) {
      return handleSetDnsDhcp(ctx, joined);
    }
    return handleSetDnsStatic(ctx, joined);
  }

  if (lower.startsWith('address')) {
    if (lower.match(/address\s+.*\s+dhcp/)) {
      return handleSetAddressDhcp(ctx, joined);
    }
    return handleSetAddressStatic(ctx, joined);
  }

  return 'Usage: set address|dns [name=]<string> [source=]dhcp|static ...';
}

function handleSetAddressStatic(ctx: WinCommandContext, joined: string): string {
  const match = joined.match(
    /address\s+"([^"]+)"\s+static\s+([\d.]+)\s+([\d.]+)(?:\s+([\d.]+))?/i
  ) || joined.match(
    /address\s+(.+?)\s+static\s+([\d.]+)\s+([\d.]+)(?:\s+([\d.]+))?/i
  );

  if (!match) {
    return 'Usage: netsh interface ip set address "name" static <ip> <mask> [gateway]';
  }

  const ifName = match[1].trim();
  const portName = resolveAdapterName(ifName, ctx.ports);
  const port = ctx.ports.get(portName);
  if (!port) return `The interface "${ifName}" was not found.`;

  try {
    ctx.configureInterface(portName, new IPAddress(match[2]), new SubnetMask(match[3]));
    if (match[4]) {
      ctx.setDefaultGateway(new IPAddress(match[4]));
    }
    return 'Ok.';
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function handleSetAddressDhcp(ctx: WinCommandContext, joined: string): string {
  const match = joined.match(/address\s+"([^"]+)"\s+dhcp/i)
    || joined.match(/address\s+(.+?)\s+dhcp/i);

  if (!match) {
    return 'Usage: netsh interface ip set address "name" dhcp';
  }

  const ifName = match[1].trim();
  const portName = resolveAdapterName(ifName, ctx.ports);
  const port = ctx.ports.get(portName);
  if (!port) return `The interface "${ifName}" was not found.`;

  ctx.setAddressDhcp(portName);
  return 'Ok.';
}

function handleSetDnsStatic(ctx: WinCommandContext, joined: string): string {
  const match = joined.match(/dns\s+"([^"]+)"\s+static\s+(\d+\.\d+\.\d+\.\d+)/i)
    || joined.match(/dns\s+(.+?)\s+static\s+(\d+\.\d+\.\d+\.\d+)/i);

  if (!match) {
    return 'Usage: netsh interface ip set dns "name" static <ip>';
  }

  const ifName = match[1].trim();
  const portName = resolveAdapterName(ifName, ctx.ports);
  if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

  ctx.setDnsServers(portName, [match[2]]);
  return 'Ok.';
}

function handleSetDnsDhcp(ctx: WinCommandContext, joined: string): string {
  const match = joined.match(/dns\s+"([^"]+)"\s+dhcp/i)
    || joined.match(/dns\s+(.+?)\s+dhcp/i);

  if (!match) {
    return 'Usage: netsh interface ip set dns "name" dhcp';
  }

  const ifName = match[1].trim();
  const portName = resolveAdapterName(ifName, ctx.ports);
  if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

  ctx.setDnsMode(portName, 'dhcp');
  return 'Ok.';
}

// ─── netsh interface ip add ─────────────────────────────────────────

function handleInterfaceIpAdd(ctx: WinCommandContext, joined: string): string {
  const lower = joined.toLowerCase();

  // add dns "name" <ip>
  if (lower.startsWith('dns')) {
    return handleAddDns(ctx, joined);
  }

  // add route <prefix>/<len> "name" <nexthop>
  if (lower.startsWith('route')) {
    return handleAddRoute(ctx, joined);
  }

  return 'Usage: add dns|route ...';
}

function handleAddDns(ctx: WinCommandContext, joined: string): string {
  const match = joined.match(/dns\s+"([^"]+)"\s+(\d+\.\d+\.\d+\.\d+)/i)
    || joined.match(/dns\s+(.+?)\s+(\d+\.\d+\.\d+\.\d+)/i);

  if (!match) {
    return 'Usage: netsh interface ip add dns "name" <ip>';
  }

  const ifName = match[1].trim();
  const portName = resolveAdapterName(ifName, ctx.ports);
  if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

  const existing = ctx.getDnsServers(portName);
  existing.push(match[2]);
  ctx.setDnsServers(portName, existing);
  return 'Ok.';
}

function handleAddRoute(ctx: WinCommandContext, joined: string): string {
  // add route 10.0.0.0/24 "Ethernet 0" 192.168.1.1
  const match = joined.match(/route\s+([\d.]+)\/(\d+)\s+"([^"]+)"\s+(\d+\.\d+\.\d+\.\d+)/i)
    || joined.match(/route\s+([\d.]+)\/(\d+)\s+(.+?)\s+(\d+\.\d+\.\d+\.\d+)/i);

  if (!match) {
    return 'Usage: netsh interface ip add route <prefix>/<len> "interface" <nexthop>';
  }

  const network = match[1];
  const cidr = parseInt(match[2], 10);
  const ifName = match[3].trim();
  const nextHop = match[4];

  const portName = resolveAdapterName(ifName, ctx.ports);
  if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

  try {
    const mask = SubnetMask.fromCIDR(cidr);
    ctx.addStaticRoute(new IPAddress(network), mask, new IPAddress(nextHop), 1);
    return 'Ok.';
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// ─── netsh interface ip delete ──────────────────────────────────────

function handleInterfaceIpDelete(ctx: WinCommandContext, joined: string): string {
  const lower = joined.toLowerCase();

  // delete dns "name" <ip>
  if (lower.startsWith('dns')) {
    return handleDeleteDns(ctx, joined);
  }

  // delete route <prefix>/<len> "name"
  if (lower.startsWith('route')) {
    return handleDeleteRoute(ctx, joined);
  }

  // delete address "name" addr=<ip>
  if (lower.startsWith('address')) {
    return handleDeleteAddress(ctx, joined);
  }

  return 'Usage: delete address|dns|route ...';
}

function handleDeleteDns(ctx: WinCommandContext, joined: string): string {
  const match = joined.match(/dns\s+"([^"]+)"\s+(\d+\.\d+\.\d+\.\d+)/i)
    || joined.match(/dns\s+(.+?)\s+(\d+\.\d+\.\d+\.\d+)/i);

  if (!match) {
    return 'Usage: netsh interface ip delete dns "name" <ip>';
  }

  const ifName = match[1].trim();
  const portName = resolveAdapterName(ifName, ctx.ports);
  if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

  const existing = ctx.getDnsServers(portName);
  const filtered = existing.filter(s => s !== match[2]);
  ctx.setDnsServers(portName, filtered);
  return 'Ok.';
}

function handleDeleteRoute(ctx: WinCommandContext, joined: string): string {
  // delete route 10.0.0.0/24 "Ethernet 0"
  const match = joined.match(/route\s+([\d.]+)\/(\d+)\s+"([^"]+)"/i)
    || joined.match(/route\s+([\d.]+)\/(\d+)\s+(.+)/i);

  if (!match) {
    return 'Usage: netsh interface ip delete route <prefix>/<len> "interface"';
  }

  const network = match[1];
  const cidr = parseInt(match[2], 10);

  try {
    const mask = SubnetMask.fromCIDR(cidr);
    ctx.removeRoute(new IPAddress(network), mask);
    return 'Ok.';
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function handleDeleteAddress(ctx: WinCommandContext, joined: string): string {
  // delete address "Ethernet 0" addr=192.168.1.10
  const match = joined.match(/address\s+"([^"]+)"\s+addr=(\d+\.\d+\.\d+\.\d+)/i)
    || joined.match(/address\s+(.+?)\s+addr=(\d+\.\d+\.\d+\.\d+)/i);

  if (!match) {
    return 'Usage: netsh interface ip delete address "name" addr=<ip>';
  }

  const ifName = match[1].trim();
  const portName = resolveAdapterName(ifName, ctx.ports);
  if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

  ctx.clearInterfaceIP(portName);
  return 'Ok.';
}

// ─── Helpers ────────────────────────────────────────────────────────

function resolveAdapterName(name: string, ports: Map<string, any>): string {
  if (ports.has(name)) return name;
  const ethMatch = name.match(/^Ethernet\s*(\d+)$/i);
  if (ethMatch) return `eth${ethMatch[1]}`;
  return name.replace(/^Ethernet\s*/i, 'eth');
}
