/**
 * Windows NETSH command — network shell for configuration.
 *
 * Supported (non-interactive, command-line mode):
 *   netsh /?                                           — usage help
 *   netsh interface ip set address "name" static ...   — configure static IP
 *   netsh int ip reset [logfile]                       — reset TCP/IP stack
 *   netsh winsock reset                                — reset Winsock catalog
 *   netsh interface ip show config                     — show IP config
 *   netsh interface ip show addresses                  — show addresses
 *   netsh show alias                                   — list aliases
 *   netsh show helper                                  — list helpers
 *   netsh <context> ?                                  — sub-context help
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
    // In real Windows, this enters interactive mode.
    // In simulation, show a hint.
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

  // netsh interface ?  or  netsh interface /?
  if (args[0].toLowerCase() === 'interface' || args[0].toLowerCase() === 'int') {
    if (args.length === 1 || args[1] === '?' || args[1] === '/?') {
      return NETSH_INTERFACE_HELP;
    }
    // netsh interface ip ...
    if (args[1].toLowerCase() === 'ip' || args[1].toLowerCase() === 'ipv4') {
      return handleNetshInterfaceIp(ctx, args.slice(2));
    }
    return NETSH_INTERFACE_HELP;
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
    const name = SUB_CONTEXT_STUB[args[0].toLowerCase()];
    return `The following commands are available:\n\nCommands in this context:\n?              - Displays a list of commands.\ndump           - Displays a configuration script.\nhelp           - Displays a list of commands.\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
  }

  return NETSH_USAGE;
}

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

function handleNetshInterfaceIp(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?') {
    return NETSH_INTERFACE_IP_HELP;
  }

  const joined = args.join(' ');

  // netsh interface ip show config
  if (args[0].toLowerCase() === 'show') {
    return handleInterfaceIpShow(ctx, args.slice(1));
  }

  // netsh interface ip set address "name" static <ip> <mask> [gateway]
  if (args[0].toLowerCase() === 'set') {
    return handleInterfaceIpSet(ctx, joined);
  }

  // netsh interface ip reset [logfile]
  if (args[0].toLowerCase() === 'reset') {
    ctx.resetStack();
    ctx.addDHCPEvent('RESET', 'TCP/IP stack has been reset');
    return 'Resetting Interface, OK!\nRestart the computer to complete this action.';
  }

  return NETSH_INTERFACE_IP_HELP;
}

function handleInterfaceIpShow(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0 || args[0] === '?' || args[0] === '/?') {
    return `The following commands are available:\n\nCommands in this context:\nshow addresses - Shows IP address configurations.\nshow config    - Displays IP address and additional information.\nshow dns       - Displays the DNS server addresses.\nshow ipstats   - Displays IP statistics.\nshow joins     - Displays multicast groups joined.\nshow offload   - Displays the offload information.\nshow route     - Displays route table entries.\nshow subinterfaces - Shows subinterface parameters.\nshow tcpstats  - Displays TCP statistics.\nshow udpstats  - Displays UDP statistics.\nshow wins      - Displays the WINS server addresses.`;
  }

  if (args[0].toLowerCase() === 'config' || args[0].toLowerCase() === 'addresses') {
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

  return 'The syntax supplied for this command is not valid. Check help for the correct syntax.';
}

function handleInterfaceIpSet(ctx: WinCommandContext, joined: string): string {
  // set address "name with spaces" static <ip> <mask> [gateway]
  const match = joined.match(
    /address\s+"([^"]+)"\s+static\s+([\d.]+)\s+([\d.]+)(?:\s+([\d.]+))?/i
  ) || joined.match(
    /address\s+(\S+)\s+static\s+([\d.]+)\s+([\d.]+)(?:\s+([\d.]+))?/i
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

function resolveAdapterName(name: string, ports: Map<string, any>): string {
  if (ports.has(name)) return name;
  const ethMatch = name.match(/^Ethernet\s*(\d+)$/i);
  if (ethMatch) return `eth${ethMatch[1]}`;
  return name.replace(/^Ethernet\s*/i, 'eth');
}
