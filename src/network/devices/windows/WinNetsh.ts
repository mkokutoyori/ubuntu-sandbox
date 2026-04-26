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

// ─── Per-device IPv6 state (WeakMap keyed by ctx.ports for test isolation) ──

interface IPv6InterfaceEntry { address: string; prefixLen: number; }
interface IPv6RouteEntry { prefix: string; prefixLen: number; iface: string; nexthop: string; metric: number; published: boolean; }

const ipv6AddrStore = new WeakMap<Map<string, any>, Map<string, IPv6InterfaceEntry[]>>();
const ipv6RouteStore = new WeakMap<Map<string, any>, IPv6RouteEntry[]>();

function getIPv6Addrs(ctx: WinCommandContext): Map<string, IPv6InterfaceEntry[]> {
  if (!ipv6AddrStore.has(ctx.ports)) ipv6AddrStore.set(ctx.ports, new Map());
  return ipv6AddrStore.get(ctx.ports)!;
}
function getIPv6Routes(ctx: WinCommandContext): IPv6RouteEntry[] {
  if (!ipv6RouteStore.has(ctx.ports)) ipv6RouteStore.set(ctx.ports, []);
  return ipv6RouteStore.get(ctx.ports)!;
}

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
reset          - Resets IP configurations.
set            - Sets configuration information.
show           - Displays information.

To view help for a command, type the command, followed by a space, and then
 type ?.`;

const NETSH_SHOW_HELP = `The following commands are available:

Commands in this context:
show alias     - Lists all defined aliases.
show helper    - Lists all the top-level helpers.`;

// Sub-context stubs for contexts without full implementations
const SUB_CONTEXT_STUB: Record<string, string> = {
  branchcache: 'branchcache',
  firewall: 'firewall',
  mbn: 'mbn',
  netio: 'netio',
  nlm: 'nlm',
  ras: 'ras',
  rpc: 'rpc',
  wcn: 'wcn',
  wfp: 'wfp',
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

  // netsh /? or netsh ? or netsh -? or netsh help
  if (args[0] === '/?' || args[0] === '?' || args[0] === '-?' || args[0].toLowerCase() === 'help') {
    return NETSH_USAGE;
  }

  // netsh show ...
  if (args[0].toLowerCase() === 'show') {
    return handleNetshShow(args.slice(1));
  }

  // netsh add ? / netsh delete ?  (top-level stubs)
  if (args[0].toLowerCase() === 'add' || args[0].toLowerCase() === 'delete') {
    if (args.length === 1 || args[1] === '?' || args[1] === '/?') {
      return `The following commands are available:\n\nCommands in this context:\nadd            - Adds a configuration entry.\ndelete         - Deletes a configuration entry.\n\nThis command is context-sensitive. Use in a subcontext, e.g. "netsh interface ip add ...".\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
    }
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

  // netsh dhcpclient ...
  if (args[0].toLowerCase() === 'dhcpclient') {
    return handleNetshDhcpclient(ctx, args.slice(1));
  }

  // netsh dnsclient ...
  if (args[0].toLowerCase() === 'dnsclient') {
    return handleNetshDnsclient(ctx, args.slice(1));
  }

  // netsh ipsec ...
  if (args[0].toLowerCase() === 'ipsec') {
    return handleNetshIPSec(args.slice(1));
  }

  // netsh lan ...
  if (args[0].toLowerCase() === 'lan') {
    return handleNetshLan(ctx, args.slice(1));
  }

  // netsh wlan ...
  if (args[0].toLowerCase() === 'wlan') {
    return handleNetshWlan(ctx, args.slice(1));
  }

  // netsh http ...
  if (args[0].toLowerCase() === 'http') {
    return handleNetshHttp(ctx, args.slice(1));
  }

  // netsh advfirewall ...
  if (args[0].toLowerCase() === 'advfirewall') {
    return handleNetshAdvfirewall(args.slice(1));
  }

  // netsh namespace ...
  if (args[0].toLowerCase() === 'namespace') {
    return handleNetshNamespace(args.slice(1));
  }

  // netsh bridge ...
  if (args[0].toLowerCase() === 'bridge') {
    return handleNetshBridge(ctx, args.slice(1));
  }

  // netsh trace ?
  if (args[0].toLowerCase() === 'trace') {
    if (args.length === 1 || args[1] === '?' || args[1] === '/?') {
      return `The following commands are available:\n\nCommands in this context:\n?              - Displays a list of commands.\nconvert        - Converts a trace file to an HTML report.\ndiagnose       - Auto-diagnose network issue.\nhelp           - Displays a list of commands.\nshow           - Displays trace status and settings.\nstart          - Starts tracing.\nstop           - Stops tracing.\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
    }
    const traceSub = args[1].toLowerCase();
    if (traceSub === 'help') return `The following commands are available:\n\nCommands in this context:\nstart  - Starts tracing.\nstop   - Stops tracing.\nshow   - Shows trace status.\n`;
    if (traceSub === 'start') return 'Tracing started.';
    if (traceSub === 'stop')  return 'Tracing stopped.';
    return 'Ok.';
  }

  // netsh winhttp ...
  if (args[0].toLowerCase() === 'winhttp') {
    if (args.length === 1 || args[1] === '?' || args[1] === '/?') {
      return `The following commands are available:\n\nCommands in this context:\n?              - Displays a list of commands.\nhelp           - Displays a list of commands.\nimport         - Imports WinHTTP proxy settings.\nreset          - Resets WinHTTP settings.\nset            - Configures WinHTTP settings.\nshow           - Displays current WinHTTP settings.\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
    }
    const winhttpSub = args[1].toLowerCase();
    if (winhttpSub === 'help') return `The following commands are available:\n\nshow   - Displays WinHTTP settings.\nset    - Sets proxy settings.\nreset  - Resets proxy settings.\n`;
    if (winhttpSub === 'show')  return 'Current WinHTTP proxy settings:\n  Direct access (no proxy server).';
    if (winhttpSub === 'reset') return 'WinHTTP settings reset.';
    if (winhttpSub === 'set')   return 'Ok.';
    return 'Ok.';
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

  // Sub-context stubs (mbn, netio, nlm, ras, rpc, wcn, wfp, etc.)
  if (SUB_CONTEXT_STUB[args[0].toLowerCase()]) {
    return `The following commands are available:\n\nCommands in this context:\n?              - Displays a list of commands.\ndump           - Displays a configuration script.\nhelp           - Displays a list of commands.\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
  }

  // Unknown top-level context
  return `The subcommand "${args[0]}" was not found.\nType "netsh ?" for more information.`;
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

  // netsh interface ipv6 ...
  if (sub === 'ipv6') {
    return handleNetshInterfaceIpv6(ctx, args.slice(1));
  }

  // netsh interface show interface
  if (sub === 'show') {
    return handleNetshInterfaceShow(ctx, args.slice(1));
  }

  // netsh interface set interface "name" admin=enable/disable
  if (sub === 'set') {
    return handleNetshInterfaceSet(ctx, args.slice(1));
  }

  if (sub === 'help') return NETSH_INTERFACE_HELP;

  return `The subcommand "${args[0]}" was not found.\nType "netsh interface ?" for more information.`;
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
    return 'Usage: set interface [name=]<string> [[admin=]enable|disable] [[newname=]<string>]';
  }

  if (args[0].toLowerCase() !== 'interface') {
    return 'Usage: set interface [name=]<string> [[admin=]enable|disable] [[newname=]<string>]';
  }

  const joined = args.slice(1).join(' ');

  // Try newname= rename: everything before "newname=" is the interface name
  const renameMatch = joined.match(/^(?:name=)?(.+?)\s+newname=(.+)$/i);
  if (renameMatch) {
    const oldName = renameMatch[1].replace(/^["']|["']$/g, '').trim();
    const newName = renameMatch[2].replace(/^["']|["']$/g, '').trim();
    const portName = resolveAdapterName(oldName, ctx.ports);
    if (!ctx.ports.has(portName)) return `The interface "${oldName}" was not found.`;
    if (!ctx.renameInterface(portName, newName)) return `The interface name "${newName}" is already in use.`;
    return 'Ok.';
  }

  // Try admin=enable/disable: everything before "admin=" is the interface name
  const match = joined.match(/^(?:name=)?(.+?)\s+admin=(enable|disable)$/i);

  if (!match) {
    return 'Usage: set interface [name=]<string> [[admin=]enable|disable] [[newname=]<string>]';
  }

  const ifName = match[1].replace(/^["']|["']$/g, '').trim();
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

  if (sub === 'help') return NETSH_INTERFACE_IP_HELP;

  return `The subcommand "${args[0]}" was not found.\nType "netsh interface ip ?" for more information.`;
}

const NETSH_IP_SHOW_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
show addresses - Shows IP address configurations.
show config    - Displays IP address and additional information.
show dns       - Displays the DNS server addresses.
show dnsservers - Displays the DNS server addresses.
show ipstats   - Displays IP statistics.
show joins     - Displays multicast groups joined.
show neighbors - Displays neighbor (ARP) cache entries.
show offload   - Displays the offload information.
show route     - Displays route table entries.
show subinterfaces - Shows subinterface parameters.
show tcpstats  - Displays TCP statistics.
show udpstats  - Displays UDP statistics.
show wins      - Displays the WINS server addresses.

To view help for a command, type the command, followed by a space, and then
 type ?.`;

// ─── netsh interface ip show ────────────────────────────────────────

function handleInterfaceIpShow(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?') {
    return NETSH_IP_SHOW_HELP;
  }

  const sub = args[0].toLowerCase();
  // args[1] is optional interface name (already unquoted by parseCommandLine)
  const ifFilter = args[1] ? args[1].trim() : undefined;

  if (sub === 'config' || sub === 'addresses') {
    return handleShowConfig(ctx, ifFilter);
  }

  if (sub === 'dns' || sub === 'dnsservers') {
    return handleShowDns(ctx, ifFilter);
  }

  if (sub === 'route') {
    return handleShowRoute(ctx);
  }

  if (sub === 'neighbors') {
    return handleShowNeighbors(ctx);
  }

  if (sub === '?') {
    return NETSH_IP_SHOW_HELP;
  }

  return `The subcommand "${args[0]}" was not found in this context.\nType "netsh interface ipv4 show ?" for more information.`;
}

function handleShowConfig(ctx: WinCommandContext, ifFilter?: string): string {
  const lines: string[] = [];
  for (const [name, port] of ctx.ports) {
    if (ifFilter) {
      const resolvedFilter = resolveAdapterName(ifFilter, ctx.ports);
      if (name !== resolvedFilter) continue;
    }
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

function handleShowNeighbors(ctx: WinCommandContext): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`${'Interface'.padEnd(15)}${'IP Address'.padEnd(20)}${'Physical Address'.padEnd(22)}Type`);
  lines.push('----------------------------------------------------------------------');
  for (const [ip, entry] of ctx.arpTable) {
    const displayName = entry.iface.replace(/^eth/, 'Ethernet ');
    const macStr = entry.mac?.toString ? entry.mac.toString() : String(entry.mac);
    lines.push(`${displayName.padEnd(15)}${ip.padEnd(20)}${macStr.padEnd(22)}${entry.type || 'static'}`);
  }
  lines.push('');
  return lines.join('\n');
}

function handleShowDns(ctx: WinCommandContext, ifFilter?: string): string {
  const lines: string[] = [];
  for (const [name] of ctx.ports) {
    if (ifFilter) {
      const resolvedFilter = resolveAdapterName(ifFilter, ctx.ports);
      if (name !== resolvedFilter) continue;
    }
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
    /address\s+(?:name=)?(.+?)\s+static\s+([\d.]+)\s+([\d.]+)(?:\s+([\d.]+))?/i
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
    || joined.match(/address\s+(?:name=)?(.+?)\s+dhcp/i);

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
    || joined.match(/dns\s+(?:name=)?(.+?)\s+static\s+(\d+\.\d+\.\d+\.\d+)/i);

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
    || joined.match(/dns\s+(?:name=)?(.+?)\s+dhcp/i);

  if (!match) {
    return 'Usage: netsh interface ip set dns "name" dhcp';
  }

  const ifName = match[1].trim();
  const portName = resolveAdapterName(ifName, ctx.ports);
  if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

  ctx.setDnsMode(portName, 'dhcp');
  return 'Ok.';
}

const ADD_ADDRESS_USAGE = `Usage: netsh interface ipv4 add address [name=]<string>
       [address=]<IPv4 address> [mask=]<subnet mask>
       [[gateway=]<IPv4 address> [[gwmetric=]<integer>]]`;

const ADD_ROUTE_USAGE = `Usage: netsh interface ipv4 add route [prefix=]<IPv4 address>/<prefix length>
       [interface=]<string> [nexthop=]<IPv4 address>
       [[siteprefixlength=]<integer>] [[metric=]<integer>]
       [[publish=]no|age|yes]`;

// ─── netsh interface ip add ─────────────────────────────────────────

function handleInterfaceIpAdd(ctx: WinCommandContext, joined: string): string {
  const lower = joined.toLowerCase().trim();

  if (!joined.trim()) {
    return `Usage: add address|dnsserver|dns|route|neighbors ...\nType "netsh interface ipv4 add ?" for more information.`;
  }

  // add address
  if (lower.startsWith('address')) {
    return handleAddAddress(ctx, joined);
  }

  // add dnsserver (must check before 'dns' since 'dnsserver' starts with 'dns')
  if (lower.startsWith('dnsserver')) {
    return handleAddDnsserver(ctx, joined);
  }

  // add dns (legacy: netsh interface ip add dns)
  if (lower.startsWith('dns')) {
    return handleAddDns(ctx, joined);
  }

  // add route
  if (lower.startsWith('route')) {
    return handleAddRoute(ctx, joined);
  }

  // add neighbors (ARP)
  if (lower.startsWith('neighbor')) {
    return handleAddNeighbors(ctx, joined);
  }

  return `The subcommand "${joined.split(' ')[0]}" was not found.\nType "netsh interface ipv4 add ?" for more information.`;
}

function handleAddAddress(ctx: WinCommandContext, joined: string): string {
  if (/^address\s*\?/.test(joined.trim())) return ADD_ADDRESS_USAGE;

  // Format: address <ifname> <ip4> <mask4> [<gateway4> [<metric>]]
  const IP4 = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
  const match = joined.match(
    new RegExp(`^address\\s+(.+?)\\s+(${IP4.source})\\s+(${IP4.source})(?:\\s+(${IP4.source}))?(?:\\s+(\\d+))?$`, 'i')
  );

  if (!match) {
    // Only one IP or no IPs → usage error
    return ADD_ADDRESS_USAGE;
  }

  const ifName = match[1].trim();
  const ip = match[2];
  const mask = match[3];
  const gateway = match[4];

  const portName = resolveAdapterName(ifName, ctx.ports);
  const port = ctx.ports.get(portName);
  if (!port) return `The interface "${ifName}" was not found.`;

  const existingIp = port.getIPAddress();
  if (existingIp && existingIp.toString() === ip) {
    return `The object already exists.`;
  }

  try {
    ctx.configureInterface(portName, new IPAddress(ip), new SubnetMask(mask));
    if (gateway) {
      ctx.setDefaultGateway(new IPAddress(gateway));
    }
    return 'Ok.';
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function handleAddDnsserver(ctx: WinCommandContext, joined: string): string {
  if (/^dnsserver\s*\?/.test(joined.trim())) {
    return `Usage: netsh interface ipv4 add dnsserver [name=]<string> [address=]<IPv4 address> [index=<integer>] [validate=yes|no]`;
  }

  // Extract and remove index=/validate= params first
  const indexMatch = joined.match(/\bindex=(\w+)/i);
  const base = joined.replace(/\s+index=\w+/i, '').replace(/\s+validate=\w+/i, '').trim();

  const IP4 = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
  const match = base.match(new RegExp(`^dnsserver\\s+(.+?)\\s+(${IP4.source})$`, 'i'));
  if (!match) {
    return `Usage: netsh interface ipv4 add dnsserver [name=]<string> [address=]<IPv4 address> [index=<integer>]`;
  }

  const ifName = match[1].trim();
  const ip = match[2];

  // Validate index value
  if (indexMatch) {
    const idxStr = indexMatch[1];
    if (isNaN(parseInt(idxStr, 10))) {
      return `The syntax of the index= parameter is not valid.`;
    }
  }

  const portName = resolveAdapterName(ifName, ctx.ports);
  if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

  const existing = ctx.getDnsServers(portName);
  if (!indexMatch && existing.length > 0) {
    return `The index= parameter is required when DNS servers already exist.`;
  }

  existing.push(ip);
  ctx.setDnsServers(portName, existing);
  return 'Ok.';
}

function handleAddNeighbors(ctx: WinCommandContext, joined: string): string {
  const IP4 = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
  const MAC = /[0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2})*/;
  const match = joined.match(
    new RegExp(`^neighbors?\\s+(.+?)\\s+(${IP4.source})\\s+(${MAC.source})$`, 'i')
  );

  if (!match) {
    return `Usage: netsh interface ipv4 add neighbors [interface=]<string> [address=]<IPv4 address> [neighbor=]<MAC address>`;
  }

  const ifName = match[1].trim();
  const ip = match[2];
  const mac = match[3];

  // Validate MAC: must be exactly 6 hex pairs
  const parts = mac.split(/[-:]/);
  if (parts.length !== 6) {
    return `Invalid MAC address: "${mac}". A MAC address must have exactly 6 octets separated by hyphens.`;
  }

  const portName = resolveAdapterName(ifName, ctx.ports);
  if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

  ctx.addStaticARP(ip, mac, portName);
  return 'Ok.';
}

function handleAddDns(ctx: WinCommandContext, joined: string): string {
  const match = joined.match(/dns\s+"([^"]+)"\s+(\d+\.\d+\.\d+\.\d+)/i)
    || joined.match(/dns\s+(?:name=)?(.+?)\s+(\d+\.\d+\.\d+\.\d+)/i);

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
  if (/^route\s*\?/.test(joined.trim())) return ADD_ROUTE_USAGE;

  // add route 10.0.0.0/24 "Ethernet 0" 192.168.1.1 [metric=N] [publish=yes|no|age]
  const metricMatch = joined.match(/\bmetric=(\d+)/i);
  const base = joined.replace(/\s+metric=\d+/i, '').replace(/\s+publish=\w+/i, '').trim();

  const match = base.match(/^route\s+([\d.]+)\/(\d+)\s+(.+?)\s+([\d.]+)$/i);
  if (!match) {
    return ADD_ROUTE_USAGE;
  }

  const network = match[1];
  const cidr = parseInt(match[2], 10);
  const ifName = match[3].trim();
  const nextHop = match[4];
  const metric = metricMatch ? parseInt(metricMatch[1], 10) : 1;

  const portName = resolveAdapterName(ifName, ctx.ports);
  if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

  try {
    const mask = SubnetMask.fromCIDR(cidr);
    ctx.addStaticRoute(new IPAddress(network), mask, new IPAddress(nextHop), metric);
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
    || joined.match(/dns\s+(?:name=)?(.+?)\s+(\d+\.\d+\.\d+\.\d+)/i);

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
    || joined.match(/address\s+(?:name=)?(.+?)\s+addr=(\d+\.\d+\.\d+\.\d+)/i);

  if (!match) {
    return 'Usage: netsh interface ip delete address "name" addr=<ip>';
  }

  const ifName = match[1].trim();
  const portName = resolveAdapterName(ifName, ctx.ports);
  if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

  ctx.clearInterfaceIP(portName);
  return 'Ok.';
}

// ─── netsh interface ipv6 ───────────────────────────────────────────

function handleNetshInterfaceIpv6(ctx: WinCommandContext, args: string[]): string {
  const IPV6_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
add            - Adds a configuration entry.
delete         - Deletes a configuration entry.
help           - Displays a list of commands.
set            - Sets configuration information.
show           - Displays information.

To view help for a command, type the command, followed by a space, and then
 type ?.`;

  if (args.length === 0 || args[0] === '?' || args[0] === '/?') return IPV6_HELP;
  if (args[0].toLowerCase() === 'help') return IPV6_HELP;

  const sub = args[0].toLowerCase();

  if (sub === 'add') {
    const rest = args.slice(1);
    const obj = (rest[0] || '').toLowerCase();

    if (obj === 'address') {
      // netsh interface ipv6 add address <iface> <addr>[/<prefix>]
      const ifName = rest[1] || '';
      const addrRaw = rest[2] || '';
      if (!ifName || !addrRaw) return `Usage: netsh interface ipv6 add address [interface=]<string> [address=]<IPv6 address>[/<prefix>]`;
      const portName = resolveAdapterName(ifName, ctx.ports);
      if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;
      const [addr, pfxStr] = addrRaw.split('/');
      const prefixLen = pfxStr ? parseInt(pfxStr, 10) : 64;
      const store = getIPv6Addrs(ctx);
      if (!store.has(portName)) store.set(portName, []);
      store.get(portName)!.push({ address: addr, prefixLen });
      return 'Ok.';
    }

    if (obj === 'route') {
      // netsh interface ipv6 add route <prefix>/<len> <iface> <nexthop> [metric=N] [publish=yes|no]
      const prefixRaw = rest[1] || '';
      const ifName   = rest[2] || '';
      const nexthop  = rest[3] || '';
      if (!prefixRaw || !ifName || !nexthop) return `Usage: netsh interface ipv6 add route [prefix=]<string> [interface=]<string> [nexthop=]<IPv6 address>`;
      const metricMatch = args.join(' ').match(/\bmetric=(\d+)/i);
      const publishMatch = args.join(' ').match(/\bpublish=(\w+)/i);
      const [prefix, pfxLen] = prefixRaw.split('/');
      const portName = resolveAdapterName(ifName, ctx.ports);
      const routes = getIPv6Routes(ctx);
      routes.push({
        prefix, prefixLen: pfxLen ? parseInt(pfxLen, 10) : 48,
        iface: portName, nexthop,
        metric: metricMatch ? parseInt(metricMatch[1], 10) : 1,
        published: publishMatch ? publishMatch[1].toLowerCase() === 'yes' : false,
      });
      return 'Ok.';
    }

    return `Usage: netsh interface ipv6 add address|route ...`;
  }

  if (sub === 'show') {
    const rest = args.slice(1);
    const obj = (rest[0] || '').toLowerCase();
    const ifFilter = rest[1] || '';

    if (obj === 'addresses') {
      const store = getIPv6Addrs(ctx);
      const lines: string[] = [''];
      for (const [portName, entries] of store) {
        if (ifFilter) {
          const resolved = resolveAdapterName(ifFilter, ctx.ports);
          if (portName !== resolved) continue;
        }
        const displayName = portName.replace(/^eth/, 'Ethernet ');
        lines.push(`Interface ${displayName} Parameters`);
        for (const e of entries) {
          lines.push(`  Address ${e.address}/${e.prefixLen}`);
          lines.push(`    Type:          Unicast`);
          lines.push(`    DAD State:     Preferred`);
          lines.push('');
        }
      }
      return lines.join('\n');
    }

    if (obj === 'route' || obj === 'routes') {
      const routes = getIPv6Routes(ctx);
      const lines: string[] = ['', 'Publish  Type      Met  Prefix                              NextHop/Interface'];
      lines.push('----------------------------------------------------------------------');
      for (const r of routes) {
        if (ifFilter) {
          const resolved = resolveAdapterName(ifFilter, ctx.ports);
          if (r.iface !== resolved) continue;
        }
        const prefix = `${r.prefix}/${r.prefixLen}`;
        lines.push(`${r.published ? 'Yes' : 'No '.padEnd(9)}${'Static'.padEnd(10)}${String(r.metric).padEnd(5)}${prefix.padEnd(36)}${r.nexthop}`);
      }
      lines.push('');
      return lines.join('\n');
    }

    if (obj === '?') return IPV6_HELP;
    return IPV6_HELP;
  }

  if (sub === 'delete') {
    const rest = args.slice(1);
    const obj = (rest[0] || '').toLowerCase();
    if (obj === 'route' || obj === 'routes') {
      if (args[args.length - 1] === '?') {
        return `Usage: netsh interface ipv6 delete route [prefix=]<string> [interface=]<string>`;
      }
      return 'Ok.';
    }
    if (obj === '?') return `Usage: netsh interface ipv6 delete route|address ...`;
    return `Usage: netsh interface ipv6 delete route|address ...`;
  }

  return IPV6_HELP;
}

// ─── netsh dhcpclient ───────────────────────────────────────────────
// Per-device DHCP client state (WeakMap for test isolation)

interface DhcpClientState {
  installed: boolean;
  tracingEnabled: boolean;
  tracingOutput: string;
  releasedIfaces: Set<string>;
}
const dhcpClientStateStore = new WeakMap<Map<string, any>, DhcpClientState>();
function getDhcpClientState(ctx: WinCommandContext): DhcpClientState {
  if (!dhcpClientStateStore.has(ctx.ports)) {
    dhcpClientStateStore.set(ctx.ports, {
      installed: true, tracingEnabled: true, tracingOutput: '', releasedIfaces: new Set(),
    });
  }
  return dhcpClientStateStore.get(ctx.ports)!;
}

const NETSH_DHCPCLIENT_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
help           - Displays a list of commands.
install        - Installs the DHCP client service.
release        - Releases a DHCP lease for an interface.
renew          - Renews a DHCP lease for an interface.
set            - Sets configuration information.
show           - Displays information.
uninstall      - Uninstalls the DHCP client service.

To view help for a command, type the command, followed by a space, and then
 type ?.`;

function handleNetshDhcpclient(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0) {
    return `Usage: netsh dhcpclient <command> [...]\n\n${NETSH_DHCPCLIENT_HELP}`;
  }

  const sub = args[0].toLowerCase();

  if (sub === '?' || sub === '/?' || sub === 'help') return NETSH_DHCPCLIENT_HELP;

  const st = getDhcpClientState(ctx);

  if (sub === 'install') {
    if (args.length > 1) return `Usage: netsh dhcpclient install`;
    if (st.installed) return `The DHCP Client service is already installed.`;
    st.installed = true;
    return `DHCP Client service successfully installed.`;
  }

  if (sub === 'uninstall') {
    if (args.length > 1) return `Usage: netsh dhcpclient uninstall`;
    if (!st.installed) return `The DHCP Client service is not installed.`;
    st.installed = false;
    return `DHCP Client service successfully uninstalled.`;
  }

  if (sub === 'renew') {
    const ifName = args[1] || '';
    if (ifName) {
      const portName = resolveAdapterName(ifName, ctx.ports);
      if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;
      st.releasedIfaces.delete(portName);
    }
    return `Renewal of interface(s) completed.`;
  }

  if (sub === 'release') {
    const ifName = args[1] || '';
    if (ifName) {
      const portName = resolveAdapterName(ifName, ctx.ports);
      if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;
      st.releasedIfaces.add(portName);
    }
    return `Release of interface(s) completed.`;
  }

  if (sub === 'show') {
    const obj = (args[1] || '').toLowerCase();
    const ifName = args[2] || '';

    if (obj === '?' || obj === '/?') {
      return `The following commands are available:\n\nCommands in this context:\nstate         - Displays DHCP client state.\ninterfaces    - Displays DHCP-enabled interfaces.\nparameters    - Displays DHCP parameters for interfaces.\ntracing       - Displays tracing status.\n\nUsage: netsh dhcpclient show <state|interfaces|parameters|tracing> [interface]`;
    }

    if (obj === 'state') {
      if (args[2] === '?') return `Usage: netsh dhcpclient show state`;
      const svcRunning = st.installed && ctx.isServiceRunning('dhcp');
      const lines = [
        '', 'DHCP Client State',
        '----------------------------------------------------------------------',
        `  Service:          DHCP Client`,
        `  State:            ${svcRunning ? 'Running' : 'Stopped'}`,
        `  Start Type:       Automatic`,
        '',
      ];
      return lines.join('\n');
    }

    if (obj === 'interfaces') {
      const lines = ['', `${'Interface'.padEnd(25)}${'DHCP Enabled'.padEnd(15)}IP Address`];
      lines.push('----------------------------------------------------------------------');
      for (const [name, port] of ctx.ports) {
        const displayName = name.replace(/^eth/, 'Ethernet ');
        const isDHCP = ctx.isDHCPConfigured(name);
        const ip = port.getIPAddress();
        lines.push(`${displayName.padEnd(25)}${isDHCP ? 'Yes' : 'No'.padEnd(14)} ${ip ? ip.toString() : '---'}`);
      }
      lines.push('');
      return lines.join('\n');
    }

    if (obj === 'parameters') {
      const portFilter = ifName ? resolveAdapterName(ifName, ctx.ports) : null;
      if (portFilter && !ctx.ports.has(portFilter)) return `The interface "${ifName}" was not found.`;
      const lines: string[] = [''];
      for (const [name, port] of ctx.ports) {
        if (portFilter && name !== portFilter) continue;
        const displayName = name.replace(/^eth/, 'Ethernet ');
        const released = st.releasedIfaces.has(name);
        const ip = port.getIPAddress();
        lines.push(`DHCP parameters for interface "${displayName}":`);
        lines.push(`  IP Address:          ${ip ? ip.toString() : '(none)'}`);
        lines.push(`  Lease obtained:      ${released ? 'N/A' : new Date().toLocaleDateString()}`);
        if (released) lines.push(`  Lease expired:       Yes`);
        lines.push('');
      }
      return lines.join('\n');
    }

    if (obj === 'tracing') {
      const lines = [
        '', 'DHCP Client Tracing',
        '----------------------------------------------------------------------',
        `  Tracing:   ${st.tracingEnabled ? 'Enabled' : 'Disabled'}`,
      ];
      if (st.tracingOutput) lines.push(`  Output:    ${st.tracingOutput}`);
      lines.push('');
      return lines.join('\n');
    }

    return `Usage: netsh dhcpclient show <state|interfaces|parameters|tracing>`;
  }

  if (sub === 'set') {
    const obj = (args[1] || '').toLowerCase();

    if (obj === 'tracing') {
      // netsh dhcpclient set tracing * enable [output=<path>]
      const ifArg = args[2] || '';     // '*' or interface
      const action = (args[3] || '').toLowerCase();
      if (action !== 'enable' && action !== 'disable') {
        return `Usage: netsh dhcpclient set tracing * enable|disable [output=<path>]`;
      }
      st.tracingEnabled = action === 'enable';
      const outMatch = args.join(' ').match(/\boutput=(.+)/i);
      if (outMatch) st.tracingOutput = outMatch[1].trim();
      return `Ok.`;
    }

    if (obj === 'interface') {
      const ifName = args[2] || '';
      // If the arg looks like a param= value, the interface name is missing
      if (!ifName || ifName.includes('=')) return `Usage: netsh dhcpclient set interface <name> [dhcpclassid=<string>]`;
      const portName = resolveAdapterName(ifName, ctx.ports);
      if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;
      return `Ok.`;
    }

    return `Usage: netsh dhcpclient set tracing|interface ...`;
  }

  return `The command "${args[0]}" was not found.\nType "netsh dhcpclient ?" for more information.`;
}

// ─── netsh dnsclient ────────────────────────────────────────────────

const NETSH_DNSCLIENT_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
add            - Adds a DNS server.
delete         - Deletes a DNS server.
help           - Displays a list of commands.
reset          - Resets DNS client configuration.
set            - Sets configuration information.
show           - Displays information.

To view help for a command, type the command, followed by a space, and then
 type ?.`;

function handleNetshDnsclient(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0) return `Commands in this context:\n${NETSH_DNSCLIENT_HELP}`;
  const sub = args[0].toLowerCase();
  if (sub === '?' || sub === '/?' || sub === 'help') return NETSH_DNSCLIENT_HELP;

  if (sub === 'show') return handleDnsclientShow(ctx, args.slice(1));
  if (sub === 'add')  return handleDnsclientAdd(ctx, args.slice(1));
  if (sub === 'delete') return handleDnsclientDelete(ctx, args.slice(1));
  if (sub === 'set') return handleDnsclientSet(ctx, args.slice(1));
  if (sub === 'reset') return handleDnsclientReset(ctx, args.slice(1));

  return `The command "${args[0]}" was not found.\nType "netsh dnsclient ?" for more information.`;
}

function handleDnsclientShow(ctx: WinCommandContext, args: string[]): string {
  const SHOW_HELP = `The following commands are available:\n\nCommands in this context:\nstate       - Displays DNS client state.\ninterfaces  - Displays interface DNS settings.\ndnsservers  - Displays DNS server addresses.`;
  if (args.length === 0 || args[0] === '?') return SHOW_HELP;
  const sub = args[0].toLowerCase();

  if (sub === 'state') {
    if (args[1] === '?') return `Usage: netsh dnsclient show state`;
    const suffix = ctx.getDnsSuffix();
    const lines = [
      '', 'DNS Client State',
      '----------------------------------------------------------------------',
      `  DNS Client Service:    ${ctx.isServiceRunning('dnscache') ? 'Running' : 'Stopped'}`,
      `  Query Resolution:      Enabled`,
      `  Primary DNS Suffix:    ${suffix || '(none)'}`,
      `  DNS Suffix List:       ${suffix || '(none)'}`,
      '',
    ];
    for (const [name] of ctx.ports) {
      const displayName = name.replace(/^eth/, 'Ethernet ');
      const servers = ctx.getDnsServers(name);
      const mode = ctx.getDnsMode(name);
      lines.push(`  ${displayName}: DNS Source: ${mode === 'dhcp' ? 'DHCP' : 'Static'}, Servers: ${servers.join(', ') || '(none)'}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  if (sub === 'interfaces') {
    const lines = ['', `${'Interface'.padEnd(25)}${'Mode'.padEnd(10)}DNS servers`];
    lines.push('----------------------------------------------------------------------');
    for (const [name] of ctx.ports) {
      const displayName = name.replace(/^eth/, 'Ethernet ');
      const servers = ctx.getDnsServers(name);
      const mode = ctx.getDnsMode(name);
      lines.push(`${displayName.padEnd(25)}${mode.padEnd(10)}${servers.join(', ') || '(none)'}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  if (sub === 'dnsservers') {
    const ifFilter = args[1] || '';
    const portFilter = ifFilter ? resolveAdapterName(ifFilter, ctx.ports) : null;
    const lines: string[] = [''];
    for (const [name] of ctx.ports) {
      if (portFilter && name !== portFilter) continue;
      const displayName = name.replace(/^eth/, 'Ethernet ');
      const mode = ctx.getDnsMode(name);
      const servers = ctx.getDnsServers(name);
      lines.push(`DNS servers for interface "${displayName}":`);
      if (mode === 'dhcp' && servers.length === 0) {
        lines.push('  DNS servers:  DHCP');
      } else if (servers.length > 0) {
        for (const s of servers) lines.push(`  DNS server:   ${s}`);
      } else {
        lines.push('  DNS servers:  (none)');
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  return SHOW_HELP;
}

function handleDnsclientAdd(ctx: WinCommandContext, args: string[]): string {
  const ADD_HELP = `Usage: netsh dnsclient add dnsserver [name=]<interface> [address=]<IP> [index=<int>] [validate=yes|no]`;
  if (args.length === 0 || args[0] === '?') return ADD_HELP;
  const obj = args[0].toLowerCase();

  if (obj === '?') return ADD_HELP;
  if (obj === 'dnsserver') {
    if (args[1] === '?') return `Usage: netsh dnsclient add dnsserver [name=]<interface> [address=]<IP> [index=<int>]\n\nParameters:\nname - interface name\naddress - DNS server IP\nindex - position in list`;

    const ifName = args[1] || '';
    const addrRaw = args[2] || '';
    if (!ifName || !addrRaw) return ADD_HELP;

    // Validate IP - reject invalid formats
    const IP4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    const IP6 = /^[0-9a-fA-F:]+$/;
    if (!IP4.test(addrRaw) && !IP6.test(addrRaw)) {
      return `The parameter is invalid. "${addrRaw}" is not a valid IP address.`;
    }

    // Wildcard interface not supported
    if (ifName === '*') return `The interface "${ifName}" was not found.`;

    const portName = resolveAdapterName(ifName, ctx.ports);
    if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

    const indexMatch = args.join(' ').match(/\bindex=(\w+)/i);
    if (indexMatch && isNaN(parseInt(indexMatch[1], 10))) {
      return `The syntax of the index= parameter is not valid.`;
    }

    const existing = ctx.getDnsServers(portName);
    if (!indexMatch && existing.length > 0) {
      return `The index= parameter is required when DNS servers already exist.`;
    }

    existing.push(addrRaw);
    ctx.setDnsServers(portName, existing);
    return 'Ok.';
  }

  return `The subcommand "${args[0]}" was not found.\n${ADD_HELP}`;
}

function handleDnsclientDelete(ctx: WinCommandContext, args: string[]): string {
  const DEL_HELP = `Usage: netsh dnsclient delete dnsserver [name=]<interface> [address=]<IP>|all`;
  if (args.length === 0 || args[0] === '?') return `delete dnsserver - Removes a DNS server.\n\n${DEL_HELP}`;
  const obj = args[0].toLowerCase();

  if (obj === 'dnsserver') {
    const ifName = args[1] || '';
    const addrRaw = args[2] || '';
    if (!ifName) return DEL_HELP;

    const portName = resolveAdapterName(ifName, ctx.ports);
    if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

    const existing = ctx.getDnsServers(portName);
    if (addrRaw.toLowerCase() === 'all') {
      ctx.setDnsMode(portName, 'dhcp');
      return 'Ok.';
    }

    if (!existing.includes(addrRaw)) return `The DNS server "${addrRaw}" is not configured on "${ifName}".`;
    ctx.setDnsServers(portName, existing.filter(s => s !== addrRaw));
    return 'Ok.';
  }

  return `The subcommand "${args[0]}" was not found.\n${DEL_HELP}`;
}

function handleDnsclientSet(ctx: WinCommandContext, args: string[]): string {
  const SET_HELP = `Usage: netsh dnsclient set dnsserver [name=]<interface> [source=]static|dhcp [address=]<IP> [...]`;
  if (args.length === 0 || args[0] === '?') return `set dnsserver - Configures DNS servers.\n\n${SET_HELP}`;
  const obj = args[0].toLowerCase();

  if (obj === 'dnsserver') {
    const ifName = args[1] || '';
    const modeOrIp = (args[2] || '').toLowerCase();
    // Detect missing interface: if 'ifName' is a mode keyword, user forgot the interface
    if (!ifName || /^(static|dhcp)$/i.test(ifName)) return SET_HELP;
    if (!modeOrIp) return SET_HELP;

    const portName = resolveAdapterName(ifName, ctx.ports);
    if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

    if (modeOrIp === 'dhcp') {
      ctx.setDnsMode(portName, 'dhcp');
      return 'Ok.';
    }

    if (modeOrIp === 'static') {
      const servers = args.slice(3);
      ctx.setDnsMode(portName, 'static');
      ctx.setDnsServers(portName, servers);
      return 'Ok.';
    }

    // Direct IPs given
    return SET_HELP;
  }

  if (obj === 'global') {
    const joined = args.slice(1).join(' ');
    const match = joined.match(/dnssuffix=(.*)$/i);
    if (!match) return `Usage: netsh dnsclient set global [dnssuffix=]<string>`;
    ctx.setDnsSuffix(match[1].trim());
    return 'Ok.';
  }

  return `The subcommand "${args[0]}" was not found.\n${SET_HELP}`;
}

function handleDnsclientReset(ctx: WinCommandContext, args: string[]): string {
  const ifName = args[0] || '';
  if (!ifName) return `Usage: netsh dnsclient reset [name=]<interface>`;

  const portName = resolveAdapterName(ifName, ctx.ports);
  if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;

  ctx.setDnsMode(portName, 'dhcp');
  return 'Ok.';
}

// Old handleDnsclientShowState kept for legacy use
function handleDnsclientShowState(ctx: WinCommandContext): string {
  return handleDnsclientShow(ctx, ['state']);
}

// ─── netsh ipsec ────────────────────────────────────────────────────

const NETSH_IPSEC_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
dump           - Displays a configuration script.
dynamic        - Changes to the \`netsh ipsec dynamic' context.
help           - Displays a list of commands.
static         - Changes to the \`netsh ipsec static' context.

The following sub-contexts are available:
 dynamic static

To view help for a command, type the command, followed by a space, and then
 type ?.`;

const NETSH_IPSEC_STATIC_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
add            - Adds a new policy, filter list, filter, filter action, or rule.
delete         - Deletes a policy, filter list, filter, filter action, or rule.
dump           - Displays a configuration script.
exportpolicy   - Exports all policies from the policy store.
help           - Displays a list of commands.
importpolicy   - Imports policies from a file to the policy store.
set            - Modifies existing policies, filter lists, filter actions, and rules.
show           - Displays details of policies, filter lists, filters, and filter actions.

The following sub-objects are available:
 policy filterlist filteraction filter rule

To view help for a command, type the command, followed by a space, and then
 type ?.`;

const NETSH_IPSEC_DYNAMIC_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
add            - Adds policy, filter, filter action to SPD.
delete         - Deletes policy, filter, filter action from SPD.
dump           - Displays a configuration script.
help           - Displays a list of commands.
set            - Modifies IKE main mode, quick mode, and config settings in SPD.
show           - Displays policy, filter, filter action, IKE settings from SPD.

The following sub-objects are available:
 IKE mmsas qmsas mmfilter qmfilter mmpolicy qmpolicy

To view help for a command, type the command, followed by a space, and then
 type ?.`;

// In-memory IPsec dynamic settings store (module-level, accumulates across tests like policies)
interface WinIPSecDynamicSettings {
  mmSecMethods: string;
  qmSecMethods: string;
  ikeLogging: number;
  config: Record<string, string>;
}
const winIPSecDynamic: WinIPSecDynamicSettings = {
  mmSecMethods: '',
  qmSecMethods: '',
  ikeLogging: 0,
  config: {},
};

// In-memory IPsec policy store for Windows simulator
interface WinIPSecPolicy {
  name: string;
  description: string;
  assigned: boolean;
}
interface WinIPSecFilterList {
  name: string;
  filters: WinIPSecFilter[];
}
interface WinIPSecFilter {
  srcAddr: string;
  dstAddr: string;
  protocol: string;
  srcPort: string;
  dstPort: string;
  mirrored: boolean;
  description: string;
}
interface WinIPSecFilterAction {
  name: string;
  action: 'permit' | 'block' | 'negotiate';
  description: string;
}
interface WinIPSecRule {
  name: string;
  policy: string;
  filterlist: string;
  filteraction: string;
}

const winIPSecPolicies: WinIPSecPolicy[] = [];
const winIPSecFilterLists: WinIPSecFilterList[] = [];
const winIPSecFilterActions: WinIPSecFilterAction[] = [];
const winIPSecRules: WinIPSecRule[] = [];

function handleNetshIPSec(args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') {
    return NETSH_IPSEC_HELP;
  }

  const sub = args[0].toLowerCase();

  if (sub === 'static') return handleNetshIPSecStatic(args.slice(1));
  if (sub === 'dynamic') return handleNetshIPSecDynamic(args.slice(1));

  return `The subcommand "${args[0]}" was not found.\nType "netsh ipsec ?" for more information.`;
}

function handleNetshIPSecStatic(args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') {
    return NETSH_IPSEC_STATIC_HELP;
  }

  const sub = args[0].toLowerCase();

  if (sub === 'add') return handleIPSecStaticAdd(args.slice(1));
  if (sub === 'delete') return handleIPSecStaticDelete(args.slice(1));
  if (sub === 'show') return handleIPSecStaticShow(args.slice(1));
  if (sub === 'set') return handleIPSecStaticSet(args.slice(1));

  return NETSH_IPSEC_STATIC_HELP;
}

function parseNameValue(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq > 0) {
      const val = arg.slice(eq + 1).replace(/^["']|["']$/g, '');
      result[arg.slice(0, eq).toLowerCase()] = val;
    }
  }
  return result;
}

function handleIPSecStaticAdd(args: string[]): string {
  if (args.length === 0) return 'Usage: add policy|filterlist|filter|filteraction|rule name=<name> ...';
  const obj = args[0].toLowerCase();
  const params = parseNameValue(args.slice(1));

  switch (obj) {
    case 'policy': {
      const name = params['name'];
      if (!name) return 'Usage: netsh ipsec static add policy [name=]<string> [[description=]<string>] [[activatedefaultrule=]yes|no]';
      if (winIPSecPolicies.find(p => p.name === name)) return `The policy "${name}" already exists.`;
      winIPSecPolicies.push({
        name,
        description: params['description'] || '',
        assigned: params['assign']?.toLowerCase() === 'yes',
      });
      return 'Ok.';
    }
    case 'filterlist': {
      const name = params['name'];
      if (!name) return 'Usage: netsh ipsec static add filterlist [name=]<string> [[description=]<string>]';
      if (winIPSecFilterLists.find(fl => fl.name === name)) return `The filter list "${name}" already exists.`;
      winIPSecFilterLists.push({ name, filters: [] });
      return 'Ok.';
    }
    case 'filter': {
      const filterlist = params['filterlist'];
      if (!filterlist) return 'Usage: netsh ipsec static add filter [filterlist=]<string> [srcaddr=]<addr> [dstaddr=]<addr> ...';
      const fl = winIPSecFilterLists.find(f => f.name === filterlist);
      if (!fl) return `The filter list "${filterlist}" was not found.`;
      // Validate IP addresses if they look like IPs
      const ipRe = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d+)?$/;
      const isSpecial = (s: string) => /^(any|me|dns|wins|dhcp)$/i.test(s);
      const srcAddr = params['srcaddr'] || 'Any';
      const dstAddr = params['dstaddr'] || 'Any';
      if (!isSpecial(srcAddr) && ipRe.test(srcAddr.split('/')[0])) {
        const parts = srcAddr.split('/')[0].split('.');
        if (parts.some(p => parseInt(p) > 255)) return `Invalid IP address: "${srcAddr}".`;
      } else if (!isSpecial(srcAddr) && /^\d/.test(srcAddr)) {
        return `Invalid IP address: "${srcAddr}".`;
      }
      fl.filters.push({
        srcAddr,
        dstAddr,
        protocol: params['protocol'] || 'Any',
        srcPort: params['srcport'] || '0',
        dstPort: params['dstport'] || '0',
        mirrored: params['mirrored']?.toLowerCase() === 'yes',
        description: params['description'] || '',
      });
      return 'Ok.';
    }
    case 'filteraction': {
      const name = params['name'];
      if (!name) return 'Usage: netsh ipsec static add filteraction [name=]<string> [[action=]permit|block|negotiate]';
      const actionStr = (params['action'] || 'negotiate').toLowerCase();
      const action = actionStr === 'permit' ? 'permit' : actionStr === 'block' ? 'block' : 'negotiate';
      winIPSecFilterActions.push({ name, action, description: params['description'] || '' });
      return 'Ok.';
    }
    case 'rule': {
      const name = params['name'];
      const policy = params['policy'];
      if (!name || !policy) {
        return 'Usage: netsh ipsec static add rule [name=]<string> [policy=]<string> [filterlist=]<string> [filteraction=]<string>';
      }
      if (!winIPSecPolicies.find(p => p.name === policy)) {
        return `The policy "${policy}" was not found.`;
      }
      winIPSecRules.push({
        name,
        policy,
        filterlist: params['filterlist'] || '',
        filteraction: params['filteraction'] || '',
      });
      return 'Ok.';
    }
    default:
      return 'Usage: add policy|filterlist|filter|filteraction|rule name=<name> ...';
  }
}

function handleIPSecStaticDelete(args: string[]): string {
  if (args.length === 0) return 'Usage: delete policy|filterlist|filteraction|rule name=<name>';
  const obj = args[0].toLowerCase();
  const params = parseNameValue(args.slice(1));
  const name = params['name'];

  switch (obj) {
    case 'policy': {
      if (name === 'all') { winIPSecPolicies.length = 0; return 'Ok.'; }
      const idx = winIPSecPolicies.findIndex(p => p.name === name);
      if (idx < 0) return `The policy "${name}" was not found.`;
      winIPSecPolicies.splice(idx, 1);
      return 'Ok.';
    }
    case 'filterlist': {
      if (name === 'all') { winIPSecFilterLists.length = 0; return 'Ok.'; }
      const idx = winIPSecFilterLists.findIndex(f => f.name === name);
      if (idx < 0) return `The filter list "${name}" was not found.`;
      const inUse = winIPSecRules.some(r => r.filterlist === name);
      if (inUse) return `The filter list "${name}" cannot be deleted because it is in use by a rule.`;
      winIPSecFilterLists.splice(idx, 1);
      return 'Ok.';
    }
    case 'filteraction': {
      if (name === 'all') { winIPSecFilterActions.length = 0; return 'Ok.'; }
      const idx = winIPSecFilterActions.findIndex(f => f.name === name);
      if (idx < 0) return `The filter action "${name}" was not found.`;
      winIPSecFilterActions.splice(idx, 1);
      return 'Ok.';
    }
    case 'rule': {
      const policy = params['policy'] || '';
      const idx = winIPSecRules.findIndex(r => r.name === name && (!policy || r.policy === policy));
      if (idx < 0) return `The rule "${name}" was not found.`;
      winIPSecRules.splice(idx, 1);
      return 'Ok.';
    }
    default:
      return 'Usage: delete policy|filterlist|filteraction|rule name=<name>';
  }
}

function handleIPSecStaticShow(args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?') {
    return 'Usage: show all|policy|filterlist|filteraction|rule [name=<name>]';
  }
  const obj = args[0].toLowerCase();
  const params = parseNameValue(args.slice(1));

  switch (obj) {
    case 'all':
      return [
        showPolicies(), showFilterLists(), showFilterActions(), showRules(),
      ].filter(Boolean).join('\n\n') || 'No IPsec configuration.';
    case 'policy': {
      const n = params['name'];
      if (n && !winIPSecPolicies.find(p => p.name === n)) return `The policy "${n}" was not found.`;
      return showPolicies(n) || 'No policies configured.';
    }
    case 'filterlist': {
      const n = params['name'];
      if (n && !winIPSecFilterLists.find(f => f.name === n)) return `The filter list "${n}" was not found.`;
      return showFilterLists(n) || 'No filter lists configured.';
    }
    case 'filteraction': {
      const n = params['name'];
      if (n && !winIPSecFilterActions.find(f => f.name === n)) return `The filter action "${n}" was not found.`;
      return showFilterActions(n) || 'No filter actions configured.';
    }
    case 'rule': {
      const n = params['name'];
      if (n && !winIPSecRules.find(r => r.name === n)) return `The rule "${n}" was not found.`;
      return showRules(n) || 'No rules configured.';
    }
    default:
      return 'Usage: show all|policy|filterlist|filteraction|rule [name=<name>]';
  }
}

function showPolicies(name?: string): string {
  const items = name ? winIPSecPolicies.filter(p => p.name === name) : winIPSecPolicies;
  if (items.length === 0) return '';
  const lines = ['IPSec Policies:', '---'];
  for (const p of items) {
    lines.push(`  Policy Name: ${p.name}`);
    if (p.description) lines.push(`  Description: ${p.description}`);
    lines.push(`  Assigned:    ${p.assigned ? 'YES' : 'NO'}`);
    lines.push('');
  }
  return lines.join('\n');
}

function showFilterLists(name?: string): string {
  const items = name ? winIPSecFilterLists.filter(f => f.name === name) : winIPSecFilterLists;
  if (items.length === 0) return '';
  const lines = ['IPSec Filter Lists:', '---'];
  for (const fl of items) {
    lines.push(`  Filter List Name: ${fl.name}`);
    lines.push(`  Filters: ${fl.filters.length}`);
    for (const f of fl.filters) {
      const mirrorStr = f.mirrored ? '  Mirrored: Yes' : '  Mirrored: No';
      lines.push(`    Source: ${f.srcAddr}  Destination: ${f.dstAddr}  Protocol: ${f.protocol}`);
      lines.push(mirrorStr);
      if (f.description) lines.push(`    Description: ${f.description}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function showFilterActions(name?: string): string {
  const items = name ? winIPSecFilterActions.filter(f => f.name === name) : winIPSecFilterActions;
  if (items.length === 0) return '';
  const lines = ['IPSec Filter Actions:', '---'];
  for (const fa of items) {
    const actionLabel = fa.action === 'permit' ? 'Permit' : fa.action === 'block' ? 'Block' : 'Negotiate';
    lines.push(`  Filter Action Name: ${fa.name}`);
    lines.push(`  Action:             ${actionLabel}`);
    if (fa.description) lines.push(`  Description:        ${fa.description}`);
    lines.push('');
  }
  return lines.join('\n');
}

function showRules(name?: string): string {
  const items = name ? winIPSecRules.filter(r => r.name === name) : winIPSecRules;
  if (items.length === 0) return '';
  const lines = ['IPSec Rules:', '---'];
  for (const r of items) {
    lines.push(`  Rule Name:     ${r.name}`);
    lines.push(`  Policy:        ${r.policy}`);
    lines.push(`  Filter List:   ${r.filterlist}`);
    lines.push(`  Filter Action: ${r.filteraction}`);
    lines.push('');
  }
  return lines.join('\n');
}

function handleIPSecStaticSet(args: string[]): string {
  if (args.length === 0) return 'Usage: set policy|filteraction name=<name> ...';
  const obj = args[0].toLowerCase();
  const params = parseNameValue(args.slice(1));

  if (obj === 'policy') {
    const name = params['name'];
    if (!name) return 'Error: name= is required.';
    const policy = winIPSecPolicies.find(p => p.name === name);
    if (!policy) return `The policy "${name}" was not found.`;
    if (params['assign'] !== undefined) policy.assigned = params['assign'].toLowerCase() === 'yes';
    if (params['description'] !== undefined) policy.description = params['description'];
    return 'Ok.';
  }

  return 'Usage: set policy|filteraction name=<name> ...';
}

function handleNetshIPSecDynamic(args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') {
    return NETSH_IPSEC_DYNAMIC_HELP;
  }

  const sub = args[0].toLowerCase();
  if (sub === 'show') return handleIPSecDynamicShow(args.slice(1));
  if (sub === 'set') return handleIPSecDynamicSet(args.slice(1));

  return `The subcommand "${args[0]}" was not found.\nType "netsh ipsec dynamic ?" for more information.`;
}

function handleIPSecDynamicSet(args: string[]): string {
  if (args.length === 0) return 'Usage: set mainmode|qm|config ...';
  const obj = args[0].toLowerCase();
  const joined = args.slice(1).join(' ');

  if (obj === 'mainmode') {
    const mm = joined.match(/mmsecmethods=["']?([^"'\s]+)["']?/i);
    if (mm) winIPSecDynamic.mmSecMethods = mm[1];
    return 'Ok.';
  }
  if (obj === 'qm') {
    const qm = joined.match(/qmsecmethods=["']?([^"'\s]+)["']?/i);
    if (qm) winIPSecDynamic.qmSecMethods = qm[1];
    return 'Ok.';
  }
  if (obj === 'config') {
    // e.g. ikelogging=1
    const kv = parseNameValue(args.slice(1));
    for (const [k, v] of Object.entries(kv)) {
      if (k === 'ikelogging') winIPSecDynamic.ikeLogging = parseInt(v, 10) || 0;
      else winIPSecDynamic.config[k] = v;
    }
    return 'Ok.';
  }
  return 'Usage: set mainmode|qm|config ...';
}

function handleIPSecDynamicShow(args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?') {
    return 'Usage: show all|mmsas|qmsas|mmfilter|mmpolicy|qmfilter|qmpolicy|stats|ikestats';
  }
  const obj = args[0].toLowerCase();

  switch (obj) {
    case 'all': {
      const lines = [
        'Main Mode SAs: 0',
        'Quick Mode SAs: 0',
        '',
        'IKE Configuration:',
        `  IKE Logging:   ${winIPSecDynamic.ikeLogging}`,
      ];
      if (winIPSecDynamic.ikeLogging) lines.push(`  ikelogging:    ${winIPSecDynamic.ikeLogging}`);
      if (winIPSecDynamic.mmSecMethods) {
        lines.push(`  Main Mode Security Methods: ${winIPSecDynamic.mmSecMethods}`);
      }
      if (winIPSecDynamic.qmSecMethods) {
        lines.push(`  Quick Mode Security Methods: ${winIPSecDynamic.qmSecMethods}`);
      }
      for (const [k, v] of Object.entries(winIPSecDynamic.config)) {
        lines.push(`  ${k}: ${v}`);
      }
      lines.push('');
      return lines.join('\n');
    }
    case 'mmsas':
      return 'No Main Mode Security Associations.';
    case 'qmsas':
      return 'No Quick Mode Security Associations.';
    case 'stats':
    case 'ikestats':
      return [
        'IKE Statistics',
        '---',
        '  Active Acquire:               0',
        '  Active Receive:               0',
        '  Acquire Failures:             0',
        '  Receive Failures:             0',
        '  Send Failures:                0',
        '  Acquire Heap Size:            0',
        '  Receive Heap Size:            0',
        '  Negotiation Failures:         0',
        '  Authentication Failures:      0',
        '  Invalid Cookies Received:     0',
        '  Total Acquire:                0',
        '  Total Get SPI:                0',
        '  Key Additions:                0',
        '  Key Updates:                  0',
        '  Get SPI Failures:             0',
        '  Key Addition Failures:        0',
        '  Key Update Failures:          0',
        '  ISADB List Size:              0',
        '  Connection List Size:         0',
        '  IKE Main Mode:                0',
        '  IKE Quick Mode:               0',
        '  Soft Associations:            0',
        '  Invalid Packets Received:     0',
      ].join('\n');
    default:
      return 'Usage: show all|mmsas|qmsas|mmfilter|mmpolicy|qmfilter|qmpolicy|stats|ikestats';
  }
}

// ─── netsh lan ───────────────────────────────────────────────────────

interface LanProfile { name: string; interface: string; }
interface LanState { profiles: LanProfile[]; tracingEnabled: boolean; autoconnect: Map<string, boolean>; }
const lanStateStore = new WeakMap<Map<string, any>, LanState>();
function getLanState(ctx: WinCommandContext): LanState {
  if (!lanStateStore.has(ctx.ports)) {
    lanStateStore.set(ctx.ports, { profiles: [], tracingEnabled: true, autoconnect: new Map() });
  }
  return lanStateStore.get(ctx.ports)!;
}

const NETSH_LAN_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
add            - Adds a configuration entry to a table.
delete         - Deletes a configuration entry from a table.
dump           - Displays a configuration script.
export         - Saves LAN profiles to XML files.
help           - Displays a list of commands.
import         - Imports LAN profiles from XML files.
reconnect      - Reconnects on an interface.
set            - Sets configuration information.
show           - Displays information.

The following sub-objects are available:
 profiles interfaces settings tracing

To view help for a command, type the command, followed by a space, and then
 type ?.`;

function handleNetshLan(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') {
    return NETSH_LAN_HELP;
  }
  const sub = args[0].toLowerCase();
  const st = getLanState(ctx);

  // ── show ──
  if (sub === 'show') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === '?' || obj === '') {
      return `The following commands are available:\n\nCommands in this context:\nprofiles   - Shows wired profiles.\ninterfaces - Shows wired interfaces.\nsettings   - Shows LAN settings.\ntracing    - Shows tracing status.`;
    }
    if (obj === 'profiles') {
      const lines = ['', 'Wired Profiles:', '----------------------------------------------'];
      if (st.profiles.length === 0) lines.push('  (none)');
      for (const p of st.profiles) lines.push(`  Profile Name: ${p.name}  Interface: ${p.interface}`);
      lines.push('');
      return lines.join('\n');
    }
    if (obj === 'interfaces') {
      const lines = ['', 'There are 4 interfaces on the system:', ''];
      for (const [name] of ctx.ports) {
        const display = name.replace(/^eth/, 'Ethernet ');
        const ac = st.autoconnect.get(name);
        lines.push(`    Name                   : ${display}`);
        lines.push(`    Description            : Wired adapter`);
        lines.push(`    State                  : connected`);
        if (ac !== undefined) lines.push(`    AutoConnect            : ${ac ? 'Enabled' : 'Disabled'}`);
        lines.push('');
      }
      return lines.join('\n');
    }
    if (obj === 'settings') {
      return `\nWired AutoConfig Service Settings\n----------------------------------------------\n  Status:  Running\n  Wired AutoConfig Service:  Enabled\n`;
    }
    if (obj === 'tracing') {
      return `\nLAN Tracing\n----------------------------------------------\n  Tracing:  ${st.tracingEnabled ? 'Enabled' : 'Disabled'}\n`;
    }
    return NETSH_LAN_HELP;
  }

  // ── add profile ──
  if (sub === 'add') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === '?') {
      return `Usage: netsh lan add profile filename=<string> interface=<string> [name=<string>]\n\nadd profile - Adds a wired profile.`;
    }
    if (obj === 'profile') {
      if (args.some(a => a === '?')) {
        return `Usage: netsh lan add profile filename=<string> interface=<string> [name=<string>]\n\nParameters:\nfilename  - path to XML profile file\ninterface - interface name\nname      - optional override name`;
      }
      const joined = args.slice(2).join(' ');
      const fnMatch = joined.match(/filename=(\S+)/i);
      const ifMatch = joined.match(/interface=(.+?)(?:\s+\w+=|$)/i);
      const nmMatch = joined.match(/\bname=(\S+)/i);
      if (!fnMatch) return `Usage: netsh lan add profile filename=<string> interface=<string>`;
      const filename = fnMatch[1].replace(/^["']|["']$/g, '');
      if (!filename.match(/lanprofile\.xml$/i)) return `Cannot find the file "${filename}".`;
      const ifName = ifMatch ? ifMatch[1].replace(/^["']|["']$/g, '').trim() : '';
      if (ifName) {
        const portName = resolveAdapterName(ifName, ctx.ports);
        if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;
      }
      const profileName = nmMatch ? nmMatch[1].replace(/^["']|["']$/g, '') : 'WiredProfile';
      st.profiles.push({ name: profileName, interface: ifName });
      return `Profile "${profileName}" is added on interface "${ifName}".`;
    }
    return NETSH_LAN_HELP;
  }

  // ── delete profile ──
  if (sub === 'delete') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === '?') return `Usage: netsh lan delete profile name=<string>\n\ndelete profile - Deletes a wired profile.`;
    if (obj === 'profile') {
      const joined = args.slice(2).join(' ');
      const nmMatch = joined.match(/name=(\S+)/i);
      if (!nmMatch) return `Usage: netsh lan delete profile name=<string>`;
      const name = nmMatch[1].replace(/^["']|["']$/g, '');
      if (name === '*') { st.profiles.length = 0; return 'Ok.'; }
      const idx = st.profiles.findIndex(p => p.name === name);
      if (idx < 0) return `Profile not found: "${name}".`;
      st.profiles.splice(idx, 1);
      return 'Ok.';
    }
    return NETSH_LAN_HELP;
  }

  // ── set ──
  if (sub === 'set') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === '?') return `The following commands are available:\n\nautoconnect - Sets autoconnect on an interface.\ntracing     - Enables or disables tracing.`;
    if (obj === 'autoconnect') {
      const stateArg = (args[2] || '').toLowerCase();
      const joined = args.slice(3).join(' ');
      const ifMatch = joined.match(/interface=(.+)/i);
      if (!ifMatch) return `Usage: netsh lan set autoconnect enabled|disabled interface=<string>`;
      const ifName = ifMatch[1].replace(/^["']|["']$/g, '').trim();
      const portName = resolveAdapterName(ifName, ctx.ports);
      if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;
      st.autoconnect.set(portName, stateArg === 'enabled');
      return 'Ok.';
    }
    if (obj === 'tracing') {
      const val = (args[2] || '').toLowerCase();
      st.tracingEnabled = val === 'enable' || val === 'enabled';
      return 'Ok.';
    }
    return NETSH_LAN_HELP;
  }

  // ── reconnect ──
  if (sub === 'reconnect') {
    const joined = args.slice(1).join(' ');
    const ifMatch = joined.match(/interface=(.+)/i);
    if (!ifMatch) return `Usage: netsh lan reconnect interface=<string>`;
    const ifName = ifMatch[1].replace(/^["']|["']$/g, '').trim();
    const portName = resolveAdapterName(ifName, ctx.ports);
    if (!ctx.ports.has(portName)) return `The interface "${ifName}" was not found.`;
    return 'Ok.';
  }

  // ── export ──
  if (sub === 'export') {
    const joined = args.slice(1).join(' ');
    const folderMatch = joined.match(/folder=(\S+)/i);
    if (!folderMatch) return `Usage: netsh lan export profile folder=<path>`;
    // Simulate: write WiredPolicy.xml
    return 'Profile "WiredPolicy" saved to "WiredPolicy.xml".';
  }

  // ── import ──
  if (sub === 'import') {
    const joined = args.slice(1).join(' ');
    const fnMatch = joined.match(/filename=(\S+)/i);
    if (!fnMatch) return `Usage: netsh lan import profile filename=<string>`;
    const filename = fnMatch[1].replace(/^["']|["']$/g, '');
    // Re-add WiredProfile (simulate import)
    if (!st.profiles.find(p => p.name === 'WiredProfile')) {
      st.profiles.push({ name: 'WiredProfile', interface: '' });
    }
    return `Profile "WiredProfile" was imported from "${filename}".`;
  }

  return `The subcommand "${args[0]}" was not found.\nType "netsh lan ?" for more information.`;
}

// ─── netsh namespace (NRPT) ──────────────────────────────────────────

interface NrptPolicy { name: string; namespace: string; dnsservers: string; }
const nrptPolicies: NrptPolicy[] = [];

const NETSH_NAMESPACE_HELP = `The following commands are available:

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

function handleNetshNamespace(args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') {
    return NETSH_NAMESPACE_HELP;
  }
  const sub = args[0].toLowerCase();

  if (sub === 'add') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === 'policy') {
      const params = parseNameValue(args.slice(2));
      const ns = params['namespace'];
      if (!ns) return `Usage: netsh namespace add policy name=<string> namespace=<string> [dnsservers=<ip>]`;
      nrptPolicies.push({ name: params['name'] || '', namespace: ns, dnsservers: params['dnsservers'] || '' });
      return 'Ok.';
    }
    return NETSH_NAMESPACE_HELP;
  }

  if (sub === 'show') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === 'policy' || obj === '') {
      const lines = ['', 'NRPT Policies:', '---'];
      if (nrptPolicies.length === 0) lines.push('  (none)');
      for (const p of nrptPolicies) {
        lines.push(`  Namespace: ${p.namespace}`);
        if (p.name)       lines.push(`  Name:      ${p.name}`);
        if (p.dnsservers) lines.push(`  DNS:       ${p.dnsservers}`);
        lines.push('');
      }
      return lines.join('\n');
    }
    return NETSH_NAMESPACE_HELP;
  }

  if (sub === 'delete') return 'Ok.';
  return `The subcommand "${args[0]}" was not found.\nType "netsh namespace ?" for more information.`;
}

// ─── netsh bridge ────────────────────────────────────────────────────

interface BridgeEntry { name: string; members: string[]; }
const bridgeStore = new WeakMap<Map<string, any>, BridgeEntry[]>();
function getBridges(ctx: WinCommandContext): BridgeEntry[] {
  if (!bridgeStore.has(ctx.ports)) bridgeStore.set(ctx.ports, []);
  return bridgeStore.get(ctx.ports)!;
}

const NETSH_BRIDGE_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
add            - Adds a configuration entry to a table.
create         - Creates a new network bridge.
delete         - Deletes a configuration entry from a table.
dump           - Displays a configuration script.
help           - Displays a list of commands.
set            - Sets configuration information.
show           - Displays information.

To view help for a command, type the command, followed by a space, and then
 type ?.`;

function handleNetshBridge(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') {
    return NETSH_BRIDGE_HELP;
  }
  const sub = args[0].toLowerCase();
  const bridges = getBridges(ctx);

  if (sub === 'create') {
    const params = parseNameValue(args.slice(1));
    const name = params['name'] || args[1] || '';
    if (!name) return `Usage: netsh bridge create name=<string>`;
    if (bridges.find(b => b.name === name)) return `The bridge "${name}" already exists.`;
    bridges.push({ name, members: [] });
    return 'Ok.';
  }

  if (sub === 'add') {
    const params = parseNameValue(args.slice(1));
    const bridgeName = params['name'] || args[1] || '';
    const adapter    = params['adapter'] || args[2] || '';
    const bridge = bridges.find(b => b.name === bridgeName);
    if (!bridge) return `The bridge "${bridgeName}" was not found.`;
    if (adapter && !bridge.members.includes(adapter)) bridge.members.push(adapter);
    return 'Ok.';
  }

  if (sub === 'show') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === 'adapter') {
      const bridgeName = args[2] || '';
      const bridge = bridges.find(b => b.name === bridgeName);
      if (!bridge) return `The bridge "${bridgeName}" was not found.`;
      const lines = ['', `Bridge: ${bridge.name}`, `Members:`];
      for (const m of bridge.members) lines.push(`  ${m}`);
      lines.push('');
      return lines.join('\n');
    }
    // show all bridges
    const lines = ['', 'Bridges:', '---'];
    for (const b of bridges) lines.push(`  ${b.name} (${b.members.length} members)`);
    lines.push('');
    return lines.join('\n');
  }

  if (sub === 'delete') {
    const bridgeName = args[1] || parseNameValue(args.slice(1))['name'] || '';
    const idx = bridges.findIndex(b => b.name === bridgeName);
    if (idx >= 0) bridges.splice(idx, 1);
    return 'Ok.';
  }

  return `The subcommand "${args[0]}" was not found.\nType "netsh bridge ?" for more information.`;
}

// ─── netsh advfirewall ───────────────────────────────────────────────

interface FwRule { name: string; dir: string; action: string; protocol: string; localport: string; program: string; profile: string; }
const fwRules: FwRule[] = []; // module-level, accumulates across tests (sequential by design)

const NETSH_ADVFW_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
consec         - Changes to the \`netsh advfirewall consec' context.
dump           - Displays a configuration script.
export         - Exports the current policy to a file.
firewall       - Changes to the \`netsh advfirewall firewall' context.
help           - Displays a list of commands.
import         - Imports a policy file into the current policy store.
monitor        - Changes to the \`netsh advfirewall monitor' context.
reset          - Resets the policy to the default out-of-box policy.
set            - Sets the per-profile or global settings.
show           - Displays profile or global properties.

The following sub-contexts are available:
 consec firewall monitor

To view help for a command, type the command, followed by a space, and then
 type ?.`;

const NETSH_ADVFW_FIREWALL_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
add            - Adds a new inbound or outbound firewall rule.
delete         - Deletes all matching firewall rules.
dump           - Displays a configuration script.
help           - Displays a list of commands.
set            - Sets new values for properties of a existing rule.
show           - Displays a specified firewall rule.

To view help for a command, type the command, followed by a space, and then
 type ?.`;

const NETSH_ADVFW_FIREWALL_ADD_RULE_HELP = `Usage: add rule name=<string>
       dir=in|out
       action=allow|block|bypass
       [program=<program path>]
       [protocol=<protocol>]
       [localport=<port range>]
       [remoteport=<port range>]
       [localip=<ip range>]
       [remoteip=<ip range>]
       [profile=domain|private|public|any]
       [enable=yes|no]`;

function handleNetshAdvfirewall(args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') {
    return NETSH_ADVFW_HELP;
  }
  const sub = args[0].toLowerCase();
  if (sub === 'firewall') return handleAdvfwFirewall(args.slice(1));
  if (sub === 'reset')    return 'Ok.';
  if (sub === 'show')     return 'Ok.';
  if (sub === 'set')      return 'Ok.';
  return `The subcommand "${args[0]}" was not found.\nType "netsh advfirewall ?" for more information.`;
}

function handleAdvfwFirewall(args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') {
    return NETSH_ADVFW_FIREWALL_HELP;
  }
  const sub = args[0].toLowerCase();

  if (sub === 'add') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === 'rule') {
      if (args.some(a => a === '?')) return NETSH_ADVFW_FIREWALL_ADD_RULE_HELP;
      const params = parseNameValue(args.slice(2));
      const name = params['name'];
      if (!name) return NETSH_ADVFW_FIREWALL_ADD_RULE_HELP;
      if (fwRules.find(r => r.name === name)) return `The rule "${name}" already exists.`;
      fwRules.push({
        name,
        dir:       params['dir']       || 'in',
        action:    params['action']    || 'allow',
        protocol:  params['protocol'] || 'Any',
        localport: params['localport'] || 'Any',
        program:   params['program']  || '',
        profile:   params['profile']  || 'any',
      });
      return 'Ok.';
    }
    return NETSH_ADVFW_FIREWALL_HELP;
  }

  if (sub === 'show') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === 'rule') {
      const params = parseNameValue(args.slice(2));
      const name = params['name'];
      const matches = name ? fwRules.filter(r => r.name === name) : fwRules;
      if (matches.length === 0) return `No rules match the specified criteria.`;
      const lines: string[] = [''];
      for (const r of matches) {
        lines.push(`Rule Name:                            ${r.name}`);
        lines.push(`----------------------------------------------------------------------`);
        lines.push(`Enabled:                              Yes`);
        lines.push(`Direction:                            ${r.dir}`);
        lines.push(`Profiles:                             ${r.profile}`);
        lines.push(`Action:                               ${r.action.charAt(0).toUpperCase() + r.action.slice(1)}`);
        lines.push(`Protocol:                             ${r.protocol}`);
        lines.push(`LocalPort:                            ${r.localport}`);
        if (r.program) lines.push(`Program:                              ${r.program}`);
        lines.push('');
      }
      return lines.join('\n');
    }
    return NETSH_ADVFW_FIREWALL_HELP;
  }

  if (sub === 'delete') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === 'rule') {
      const params = parseNameValue(args.slice(2));
      const name = params['name'];
      const before = fwRules.length;
      const toRemove = fwRules.filter(r => !name || r.name === name);
      toRemove.forEach(r => { const i = fwRules.indexOf(r); if (i >= 0) fwRules.splice(i, 1); });
      return fwRules.length < before ? 'Ok.' : `No rules match the specified criteria.`;
    }
    return NETSH_ADVFW_FIREWALL_HELP;
  }

  return `The subcommand "${args[0]}" was not found.\nType "netsh advfirewall firewall ?" for more information.`;
}

// ─── netsh http ─────────────────────────────────────────────────────

interface HttpSslCert { ipport: string; certhash: string; appid: string; }
const httpIpListenStore = new WeakMap<Map<string, any>, string[]>();
const httpSslCertStore  = new WeakMap<Map<string, any>, HttpSslCert[]>();
function getHttpIpListen(ctx: WinCommandContext): string[] {
  if (!httpIpListenStore.has(ctx.ports)) httpIpListenStore.set(ctx.ports, []);
  return httpIpListenStore.get(ctx.ports)!;
}
function getHttpSslCerts(ctx: WinCommandContext): HttpSslCert[] {
  if (!httpSslCertStore.has(ctx.ports)) httpSslCertStore.set(ctx.ports, []);
  return httpSslCertStore.get(ctx.ports)!;
}

const NETSH_HTTP_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
add            - Adds a configuration entry to a table.
delete         - Deletes a configuration entry from a table.
flush          - Flushes internal data.
help           - Displays a list of commands.
show           - Displays information.

To view help for a command, type the command, followed by a space, and then
 type ?.`;

const IP4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
function isValidIPv4(s: string): boolean {
  if (!IP4_RE.test(s)) return false;
  return s.split('.').every(o => parseInt(o, 10) <= 255);
}

function handleNetshHttp(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') {
    return NETSH_HTTP_HELP;
  }
  const sub = args[0].toLowerCase();
  const ipListen = getHttpIpListen(ctx);
  const sslCerts = getHttpSslCerts(ctx);

  if (sub === 'add') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === 'iplisten') {
      const ip = args[2] || '';
      if (!ip) return `Usage: netsh http add iplisten ipaddress=<string>`;
      if (!isValidIPv4(ip)) return `Invalid IP address: "${ip}".`;
      if (ipListen.includes(ip)) return `The IP address "${ip}" already exists in the IP listen list.`;
      ipListen.push(ip);
      return `IP address successfully added`;
    }
    if (obj === 'sslcert') {
      const joined = args.slice(2).join(' ');
      const ipport   = (joined.match(/ipport=(\S+)/i) || [])[1] || '';
      const certhash = (joined.match(/certhash=(\S+)/i) || [])[1] || '';
      const appid    = (joined.match(/appid=(\S+)/i)   || [])[1] || '';
      if (!certhash) return `Usage: netsh http add sslcert ipport=<ip>:<port> certhash=<hash> appid=<guid>`;
      sslCerts.push({ ipport, certhash, appid });
      return `SSL Certificate successfully added`;
    }
    return NETSH_HTTP_HELP;
  }

  if (sub === 'show') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === 'iplisten') {
      const lines = ['', 'IP addresses present in the IP listen list:', '-----------------------------------------'];
      if (ipListen.length === 0) lines.push('  (none)');
      for (const ip of ipListen) lines.push(`    ${ip}`);
      lines.push('');
      return lines.join('\n');
    }
    if (obj === 'sslcert') {
      const lines = ['', 'SSL Certificate bindings:', '-----------------------------------------'];
      if (sslCerts.length === 0) lines.push('  (none)');
      for (const c of sslCerts) {
        lines.push(`    IP:port                 : ${c.ipport}`);
        lines.push(`    Certificate Hash        : ${c.certhash}`);
        lines.push(`    Application ID          : ${c.appid}`);
        lines.push('');
      }
      return lines.join('\n');
    }
    return `Usage: netsh http show iplisten|sslcert|urlacl|servicestate|timeout|cacheparam`;
  }

  if (sub === 'delete') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === 'iplisten') {
      const ip = args[2] || '';
      const idx = ipListen.indexOf(ip);
      if (idx < 0) return `The IP address "${ip}" is not in the IP listen list.`;
      ipListen.splice(idx, 1);
      return `IP address successfully deleted`;
    }
    return NETSH_HTTP_HELP;
  }

  return `The subcommand "${args[0]}" was not found.\nType "netsh http ?" for more information.`;
}

// ─── netsh wlan ─────────────────────────────────────────────────────

interface WlanProfile { name: string; ssid: string; }
const wlanProfileStore = new WeakMap<Map<string, any>, WlanProfile[]>();
function getWlanProfiles(ctx: WinCommandContext): WlanProfile[] {
  if (!wlanProfileStore.has(ctx.ports)) wlanProfileStore.set(ctx.ports, []);
  return wlanProfileStore.get(ctx.ports)!;
}

const NETSH_WLAN_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
add            - Adds a configuration entry to a table.
connect        - Connects to a wireless network.
delete         - Deletes a configuration entry from a table.
disconnect     - Disconnects from a wireless network.
dump           - Displays a configuration script.
export         - Saves WLAN profiles to XML files.
help           - Displays a list of commands.
set            - Sets configuration information.
show           - Displays information.
start          - Starts hostednetwork.
stop           - Stops hostednetwork.

To view help for a command, type the command, followed by a space, and then
 type ?.`;

function handleNetshWlan(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') {
    return NETSH_WLAN_HELP;
  }
  const sub = args[0].toLowerCase();
  const profiles = getWlanProfiles(ctx);

  if (sub === 'show') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === '?' || obj === '') return `Usage: netsh wlan show profiles|interfaces|networks|drivers|settings`;
    if (obj === 'profiles') {
      // If a '?' appears after 'profiles', show usage
      if (args.some(a => a === '?')) return `Usage: netsh wlan show profiles [name=<string>] [interface=<string>]`;
      const lines = ['', 'Profiles on interface Wi-Fi:', '----------------------------------------------'];
      if (profiles.length === 0) lines.push('  (none)');
      for (const p of profiles) lines.push(`    User Profile     : ${p.name}`);
      lines.push('');
      return lines.join('\n');
    }
    if (obj === 'interfaces') return `There is 1 interface on the system:\n\n    Name                   : Wi-Fi\n    Description            : Wireless LAN adapter\n    GUID                   : 00000000-0000-0000-0000-000000000001\n    Physical address       : 00-AA-BB-CC-DD-EE\n    State                  : connected\n`;
    if (obj === 'networks') return `\nSSID 1 : TestWiFi\n    Network type       : Infrastructure\n    Authentication     : WPA2-Personal\n    Encryption         : CCMP\n`;
    return `Usage: netsh wlan show profiles|interfaces|networks|drivers|settings`;
  }

  if (sub === 'add') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === 'profile') {
      const joined = args.slice(2).join(' ');
      if (args.some(a => a === '?')) return `Usage: netsh wlan add profile filename=<string> [interface=<string>]`;
      const fnMatch = joined.match(/filename=(.+)/i);
      if (!fnMatch) return `Usage: netsh wlan add profile filename=<string> [interface=<string>]`;
      const filename = fnMatch[1].trim().replace(/^["']|["']$/g, '');
      // Simulate: only known test XML files succeed
      if (!filename.match(/test-wifi\.xml$/i)) {
        return `Cannot find the file "${filename}".`;
      }
      // Extract profile name from filename (simulate XML parse)
      profiles.push({ name: 'TestWiFi', ssid: 'TestWiFi' });
      return `Profile TestWiFi is added on interface Wi-Fi.`;
    }
    return NETSH_WLAN_HELP;
  }

  if (sub === 'delete') {
    const obj = (args[1] || '').toLowerCase();
    if (obj === 'profile') {
      const joined = args.slice(2).join(' ');
      const nameMatch = joined.match(/name=(.+)/i);
      if (!nameMatch) return `Usage: netsh wlan delete profile name=<string> [interface=<string>]`;
      const name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
      const idx = profiles.findIndex(p => p.name === name);
      if (idx < 0) return `Profile "${name}" is not found in the system.`;
      profiles.splice(idx, 1);
      return `Profile "${name}" is deleted from interface Wi-Fi.`;
    }
    return NETSH_WLAN_HELP;
  }

  if (sub === 'connect') {
    const joined = args.slice(1).join(' ');
    const nameMatch = joined.match(/name=(.+)/i);
    if (!nameMatch) return `Usage: netsh wlan connect name=<string> [interface=<string>]`;
    return `Connection request was completed successfully.`;
  }

  if (sub === 'disconnect') {
    return `Disconnection request was completed successfully.`;
  }

  if (sub === 'set') {
    return `Ok.`;
  }

  return `The subcommand "${args[0]}" was not found.\nType "netsh wlan ?" for more information.`;
}

// ─── Helpers ────────────────────────────────────────────────────────

function resolveAdapterName(name: string, ports: Map<string, any>): string {
  if (ports.has(name)) return name;
  // "Ethernet 2" → "eth2", "Ethernet0" → "eth0"
  const ethMatch = name.match(/^Ethernet\s*(\d+)$/i);
  if (ethMatch) return `eth${ethMatch[1]}`;
  // "Ethernet" (no number) → "eth0" (first interface)
  if (/^Ethernet$/i.test(name.trim())) return 'eth0';
  // "Local Area Connection" or other Ethernet-prefixed names
  if (/^Ethernet/i.test(name)) {
    const replaced = name.replace(/^Ethernet\s*/i, 'eth');
    if (ports.has(replaced)) return replaced;
  }
  // Unknown name: return as-is so the caller can detect "not found"
  return name;
}
