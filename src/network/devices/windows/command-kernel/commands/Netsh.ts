import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { IPAddress, SubnetMask, IPv6Address } from '@/network/core/types';
import { isValidIPv4 } from '@/network/core/ip';
import type { WindowsAdapterInfo, WindowsNetConfigApi } from '@/command-kernel/machine/types';

const PORT_PROXY_FAMILIES = ['v4tov4', 'v4tov6', 'v6tov4', 'v6tov6'] as const;
type PortProxyFamily = typeof PORT_PROXY_FAMILIES[number];

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

const NETSH_PORTPROXY_HELP = [
  'The following commands are available:',
  '',
  'Commands in this context:',
  'add       - Adds a configuration entry to a table.',
  'delete    - Deletes a configuration entry from a table.',
  'reset     - Resets the port proxy configuration state.',
  'set       - Updates configuration settings.',
  'show      - Displays information.',
].join('\n');

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

const SUB_CONTEXT_STUB: Record<string, string> = {
  branchcache: 'branchcache', firewall: 'firewall', mbn: 'mbn', netio: 'netio',
  nlm: 'nlm', ras: 'ras', rpc: 'rpc', wcn: 'wcn', wfp: 'wfp',
};

const NETSH_DHCP_TRACE_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
enable         - Enables DHCP client event tracing.
disable        - Disables DHCP client event tracing.
show           - Displays tracing information.

To view help for a command, type the command, followed by a space, and then
 type ?.`;

const NETSH_DHCPCLIENT_HELP = `The following commands are available:

Commands in this context:
?              - Displays a list of commands.
help           - Displays a list of commands.
install        - Installs the DHCP client service.
list           - Lists DHCP protocol interfaces and their state.
release        - Releases a DHCP lease for an interface.
renew          - Renews a DHCP lease for an interface.
set            - Sets configuration information.
show           - Displays information.
trace          - Manages DHCP event tracing.
uninstall      - Uninstalls the DHCP client service.

To view help for a command, type the command, followed by a space, and then
 type ?.`;

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

function normalizeDirection(dir: string): 'Inbound' | 'Outbound' {
  return dir.toLowerCase() === 'out' ? 'Outbound' : 'Inbound';
}
function normalizeAction(action: string): 'Allow' | 'Block' {
  return action.toLowerCase() === 'block' ? 'Block' : 'Allow';
}
function normalizeProtocol(proto: string): string {
  const p = proto.toUpperCase();
  if (p === 'TCP') return 'TCP';
  if (p === 'UDP') return 'UDP';
  if (p === 'ICMPV4' || p === 'ICMP') return 'ICMPv4';
  return 'Any';
}

const ADD_ADDRESS_USAGE = `Usage: netsh interface ipv4 add address [name=]<string>
       [address=]<IPv4 address> [mask=]<subnet mask>
       [[gateway=]<IPv4 address> [[gwmetric=]<integer>]]`;

const ADD_ROUTE_USAGE = `Usage: netsh interface ipv4 add route [prefix=]<IPv4 address>/<prefix length>
       [interface=]<string> [nexthop=]<IPv4 address>
       [[siteprefixlength=]<integer>] [[metric=]<integer>]
       [[publish=]no|age|yes]`;

function unquote(name: string): string {
  return name.trim().replace(/^["']|["']$/g, '').trim();
}

function displayName(portName: string): string {
  return portName.replace(/^eth/, 'Ethernet ');
}

function defaultListenAddress(family: PortProxyFamily): string {
  return family === 'v6tov4' || family === 'v6tov6' ? '::' : '0.0.0.0';
}

export class NetshCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'netsh',
    summary: 'Shell de configuration réseau',
    usage: NETSH_USAGE,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'contexte et sous-commande netsh' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'réseau',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.netConfig) {
      await ctx.io.stdout.write('NETSH: not supported on this device\n');
      return 1;
    }
    const out = this.dispatch(ctx, ctx.machine.netConfig, args);
    await ctx.io.stdout.write(out === '' ? '' : out + '\n');
    return EXIT_OK;
  }

  private dispatch(ctx: CommandContext, nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0) return NETSH_USAGE;

    const joined = args.join(' ');
    const joinedLower = joined.toLowerCase();
    const head = args[0].toLowerCase();

    if (args[0] === '/?' || args[0] === '?' || args[0] === '-?' || head === 'help') {
      return NETSH_USAGE;
    }

    if (head === 'routing') {
      return 'The following helper is not installed: routing. Invalid context. Routing And Remote Access service is required.';
    }

    if (head === 'show') return this.handleShow(args.slice(1));

    if (head === 'add' || head === 'delete') {
      if (args.length === 1 || args[1] === '?' || args[1] === '/?') {
        return `The following commands are available:\n\nCommands in this context:\nadd            - Adds a configuration entry.\ndelete         - Deletes a configuration entry.\n\nThis command is context-sensitive. Use in a subcontext, e.g. "netsh interface ip add ...".\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
      }
    }

    if (joinedLower.match(/winsock\s+reset/)) {
      nc.resetWinsockCatalog();
      return '\nWinsock Catalog successfully reset.\nYou must restart the computer in order to complete the reset.';
    }

    if (joinedLower.match(/int(?:erface)?\s+ip\s+reset/i)) {
      nc.resetTcpIpStack();
      return 'Resetting Interface, OK!\nRestart the computer to complete this action.';
    }

    if (head === 'interface' || head === 'int') {
      return this.handleInterface(nc, args.slice(1));
    }

    if (head === 'dhcpclient') return this.handleDhcpclient(nc, args.slice(1));
    if (head === 'dnsclient') return this.handleDnsclient(nc, args.slice(1));
    if (head === 'ipsec') return this.handleIpsec(nc, args.slice(1));
    if (head === 'lan') return this.handleLan(nc, args.slice(1));
    if (head === 'wlan') return this.handleWlan(nc, args.slice(1));
    if (head === 'http') return this.handleHttp(nc, args.slice(1));
    if (head === 'bridge') return this.handleBridge(nc, args.slice(1));
    if (head === 'namespace') return this.handleNamespace(nc, args.slice(1));

    if (head === 'advfirewall') {
      // `netsh advfirewall` exige que le service Pare-feu Windows (mpssvc) tourne.
      if (!ctx.machine.services?.isRunning('mpssvc')) {
        return 'The Windows Firewall service is not running. (mpssvc)';
      }
      return this.handleAdvfirewall(nc, args.slice(1));
    }

    if (head === 'dhcp') return this.handleDhcpServer(nc, args.slice(1));
    if (head === 'nps') return this.handleNps(nc, args.slice(1));

    if (head === 'winhttp') return this.handleWinhttp(nc, args.slice(1));

    if (head === 'trace') return this.handleTrace(args.slice(1));

    if (head === 'p2p') return P2P_HELP;

    if (head === 'winsock') {
      if (args.length === 1 || args[1] === '?' || args[1] === '/?') {
        return `The following commands are available:\n\nCommands in this context:\n?              - Displays a list of commands.\naudit          - Displays a list of Winsock LSPs that have been installed and removed.\nhelp           - Displays a list of commands.\nremove         - Removes a Winsock LSP from the system.\nreset          - Resets the Winsock Catalog to a clean state.\nset            - Sets Winsock options.\nshow           - Displays information.\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
      }
    }

    if (SUB_CONTEXT_STUB[head]) {
      return `The following commands are available:\n\nCommands in this context:\n?              - Displays a list of commands.\ndump           - Displays a configuration script.\nhelp           - Displays a list of commands.\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
    }

    return `The subcommand "${args[0]}" was not found.\nType "netsh ?" for more information.`;
  }

  // ─── netsh show ───────────────────────────────────────────────────
  private handleShow(args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?') return NETSH_SHOW_HELP;
    if (args[0].toLowerCase() === 'alias') {
      if (args[1] === '/?' || args[1] === '?') {
        return 'Usage: show alias\n\nRemarks:\n       Lists all defined aliases.';
      }
      return '';
    }
    if (args[0].toLowerCase() === 'helper') {
      return 'Top-level helpers:\n  advfirewall  branchcache  bridge  dhcpclient  dnsclient\n  firewall  http  interface  ipsec  lan  mbn  namespace\n  netio  nlm  p2p  ras  rpc  trace  wcn  wfp  winhttp\n  winsock  wlan';
    }
    return NETSH_SHOW_HELP;
  }

  // ─── netsh trace ──────────────────────────────────────────────────
  private handleTrace(args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?') {
      return `The following commands are available:\n\nCommands in this context:\n?              - Displays a list of commands.\nconvert        - Converts a trace file to an HTML report.\ndiagnose       - Auto-diagnose network issue.\nhelp           - Displays a list of commands.\nshow           - Displays trace status and settings.\nstart          - Starts tracing.\nstop           - Stops tracing.\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
    }
    const sub = args[0].toLowerCase();
    if (sub === 'help') return `The following commands are available:\n\nCommands in this context:\nstart  - Starts tracing.\nstop   - Stops tracing.\nshow   - Shows trace status.\n`;
    if (sub === 'start') return 'Tracing started.';
    if (sub === 'stop') return 'Tracing stopped.';
    return 'Ok.';
  }

  // ─── netsh winhttp ────────────────────────────────────────────────
  private handleWinhttp(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?') {
      return `The following commands are available:\n\nCommands in this context:\n?              - Displays a list of commands.\nhelp           - Displays a list of commands.\nimport         - Imports WinHTTP proxy settings.\nreset          - Resets WinHTTP settings.\nset            - Configures WinHTTP settings.\nshow           - Displays current WinHTTP settings.\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
    }
    const sub = args[0].toLowerCase();
    if (sub === 'help') return `The following commands are available:\n\nshow   - Displays WinHTTP settings.\nset    - Sets proxy settings.\nreset  - Resets proxy settings.\n`;
    if (sub === 'show') {
      const proxy = nc.winhttpProxy();
      return proxy
        ? `Current WinHTTP proxy settings:\n  Proxy Server(s) :  ${proxy}\n  Bypass List     :  (none)`
        : 'Current WinHTTP proxy settings:\n  Direct access (no proxy server).';
    }
    if (sub === 'reset') {
      nc.setWinhttpProxy('');
      return 'Direct access (no proxy server).\nCurrent WinHTTP proxy settings were reset.';
    }
    if (sub === 'set' && args[1]?.toLowerCase() === 'proxy') {
      const proxyArg = args[2]?.replace(/^["']|["']$/g, '') ?? '';
      if (!proxyArg) return 'Usage: netsh winhttp set proxy <proxy-server> [<bypass-list>]';
      nc.setWinhttpProxy(proxyArg);
      return 'Ok.';
    }
    return 'Ok.';
  }

  // ─── netsh interface ──────────────────────────────────────────────
  private handleInterface(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?') return NETSH_INTERFACE_HELP;
    const sub = args[0].toLowerCase();
    if (sub === 'ip' || sub === 'ipv4') return this.handleInterfaceIp(nc, args.slice(1));
    if (sub === 'ipv6') return this.handleInterfaceIpv6(nc, args.slice(1));
    if (sub === 'show') return this.handleInterfaceShow(nc, args.slice(1));
    if (sub === 'set') return this.handleInterfaceSet(nc, args.slice(1));
    if (sub === 'portproxy') return this.handlePortproxy(nc, args.slice(1));
    if (sub === 'help') return NETSH_INTERFACE_HELP;
    return `The subcommand "${args[0]}" was not found.\nType "netsh interface ?" for more information.`;
  }

  private handleInterfaceShow(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() !== 'interface') {
      return `The following commands are available:\n\nCommands in this context:\nshow interface - Shows interface table.`;
    }
    const lines: string[] = ['',
      'Admin State    State          Type             Interface Name',
      '-------------------------------------------------------------------------'];
    for (const a of nc.adapters()) {
      const adminState = a.adminEnabled ? 'Enabled' : 'Disabled';
      const state = !a.adminEnabled ? 'Disconnected' : (a.isConnected ? 'Connected' : 'Disconnected');
      lines.push(`${adminState.padEnd(15)}${state.padEnd(15)}${'Dedicated'.padEnd(17)}${displayName(a.name)}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private handleInterfaceSet(nc: WindowsNetConfigApi, args: string[]): string {
    const usage = 'Usage: set interface [name=]<string> [[admin=]enable|disable] [[newname=]<string>]';
    if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() !== 'interface') {
      return usage;
    }
    const joined = args.slice(1).join(' ');

    const renameMatch = joined.match(/^(?:name=)?(.+?)\s+newname=(.+)$/i);
    if (renameMatch) {
      const oldName = unquote(renameMatch[1]);
      const newName = unquote(renameMatch[2]);
      const portName = nc.resolveAdapterName(oldName);
      if (!portName) return `The interface "${oldName}" was not found.`;
      if (!nc.renameInterface(portName, newName)) return `The interface name "${newName}" is already in use.`;
      return 'Ok.';
    }

    const match = joined.match(/^(?:name=)?(.+?)\s+admin=(enable|enabled|disable|disabled)$/i);
    if (!match) return usage;

    const ifName = unquote(match[1]);
    const enable = match[2].toLowerCase().startsWith('enable');
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `The interface "${ifName}" was not found.`;
    nc.setInterfaceAdmin(portName, enable);
    return 'Ok.';
  }

  // ─── netsh interface portproxy ────────────────────────────────────
  private parsePortproxyParams(tokens: string[]): Map<string, string> {
    const params = new Map<string, string>();
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const eq = tok.indexOf('=');
      if (eq > 0) {
        params.set(tok.slice(0, eq).toLowerCase(), tok.slice(eq + 1));
      } else if (tokens[i + 1] === '=' && tokens[i + 2] !== undefined) {
        params.set(tok.toLowerCase(), tokens[i + 2]);
        i += 2;
      }
    }
    return params;
  }

  private handlePortproxy(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?') return NETSH_PORTPROXY_HELP;
    const sub = args[0].toLowerCase();
    const rest = args.slice(1);
    if (sub === 'add' || sub === 'set') return this.handlePortproxyAddSet(nc, rest);
    if (sub === 'delete') return this.handlePortproxyDelete(nc, rest);
    if (sub === 'show') return this.handlePortproxyShow(nc, rest);
    if (sub === 'reset') { nc.resetPortProxy(); return ''; }
    if (sub === 'help') return NETSH_PORTPROXY_HELP;
    return `The following command was not found: portproxy ${args.join(' ')}.`;
  }

  private handlePortproxyAddSet(nc: WindowsNetConfigApi, rest: string[]): string {
    const family = (rest[0] ?? '').toLowerCase() as PortProxyFamily;
    if (!PORT_PROXY_FAMILIES.includes(family)) {
      return `The following command was not found: portproxy add ${rest.join(' ')}.`;
    }
    const p = this.parsePortproxyParams(rest.slice(1));
    const listenPort = Number.parseInt(p.get('listenport') ?? '', 10);
    if (!Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65535) return 'The parameter is incorrect.';
    const connectPort = Number.parseInt(p.get('connectport') ?? '', 10);
    const listenAddress = p.get('listenaddress') || defaultListenAddress(family);
    const connectAddress = p.get('connectaddress') || '';
    nc.addPortProxyRule({
      family, listenAddress, listenPort, connectAddress,
      connectPort: Number.isInteger(connectPort) && connectPort > 0 ? connectPort : listenPort,
    });
    return '';
  }

  private handlePortproxyDelete(nc: WindowsNetConfigApi, rest: string[]): string {
    const family = (rest[0] ?? '').toLowerCase() as PortProxyFamily;
    if (!PORT_PROXY_FAMILIES.includes(family)) {
      return `The following command was not found: portproxy delete ${rest.join(' ')}.`;
    }
    const p = this.parsePortproxyParams(rest.slice(1));
    const listenPort = Number.parseInt(p.get('listenport') ?? '', 10);
    if (!Number.isInteger(listenPort) || listenPort <= 0) return 'The parameter is incorrect.';
    const listenAddress = p.get('listenaddress') || defaultListenAddress(family);
    return nc.removePortProxyRule(family, listenAddress, listenPort)
      ? '' : 'The system cannot find the file specified.';
  }

  private handlePortproxyShow(nc: WindowsNetConfigApi, rest: string[]): string {
    const what = (rest[0] ?? 'all').toLowerCase();
    const families: PortProxyFamily[] = what === 'all'
      ? [...PORT_PROXY_FAMILIES]
      : PORT_PROXY_FAMILIES.includes(what as PortProxyFamily) ? [what as PortProxyFamily] : [];
    if (families.length === 0) return `The following command was not found: portproxy show ${rest.join(' ')}.`;
    const sections: string[] = [];
    for (const family of families) {
      const rules = nc.portProxyRules(family);
      if (rules.length === 0 && what === 'all') continue;
      const listenFam = family.startsWith('v6') ? 'ipv6' : 'ipv4';
      const connectFam = family.endsWith('v6') ? 'ipv6' : 'ipv4';
      const lines = ['',
        `Listen on ${listenFam}:             Connect to ${connectFam}:`, '',
        'Address         Port        Address         Port',
        '--------------- ----------  --------------- ----------'];
      for (const r of rules) {
        lines.push(`${r.listenAddress.padEnd(16)}${String(r.listenPort).padEnd(12)}${r.connectAddress.padEnd(16)}${r.connectPort}`);
      }
      sections.push(lines.join('\n'));
    }
    if (sections.length === 0) return '';
    return sections.join('\n\n');
  }

  // ─── netsh interface ip ───────────────────────────────────────────
  private handleInterfaceIp(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?') return NETSH_INTERFACE_IP_HELP;
    const sub = args[0].toLowerCase();
    if (sub === 'show') return this.handleInterfaceIpShow(nc, args.slice(1));
    if (sub === 'set') return this.handleInterfaceIpSet(nc, args.slice(1).join(' '));
    if (sub === 'add') return this.handleInterfaceIpAdd(nc, args.slice(1).join(' '));
    if (sub === 'delete') return this.handleInterfaceIpDelete(nc, args.slice(1).join(' '));
    if (sub === 'reset') { nc.resetTcpIpStack(); return 'Resetting Interface, OK!\nRestart the computer to complete this action.'; }
    if (sub === 'help') return NETSH_INTERFACE_IP_HELP;
    return `The subcommand "${args[0]}" was not found.\nType "netsh interface ip ?" for more information.`;
  }

  private handleInterfaceIpShow(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?') return NETSH_IP_SHOW_HELP;
    const sub = args[0].toLowerCase();
    const ifFilter = args[1] ? args[1].trim() : undefined;
    if (sub === 'config' || sub === 'addresses' || sub === 'address') return this.handleShowConfig(nc, ifFilter);
    if (sub === 'dns' || sub === 'dnsservers') return this.handleShowDns(nc, ifFilter);
    if (sub === 'route') return this.handleShowRoute(nc);
    if (sub === 'neighbors') return this.handleShowNeighbors(nc);
    if (sub === 'dynamicport') return this.renderDynamicPort((args[1] ?? 'tcp').toLowerCase());
    if (sub === '?') return NETSH_IP_SHOW_HELP;
    return `The subcommand "${args[0]}" was not found in this context.\nType "netsh interface ipv4 show ?" for more information.`;
  }

  private renderDynamicPort(proto: string): string {
    const label = proto === 'udp' ? 'udp' : 'tcp';
    return [`Protocol ${label} Dynamic Port Range`, '---------------------------------',
      'Start Port      : 49152', 'Number of Ports : 16384', ''].join('\n');
  }

  private adapterMatches(nc: WindowsNetConfigApi, a: WindowsAdapterInfo, ifFilter?: string): boolean {
    if (!ifFilter) return true;
    return a.name === nc.resolveAdapterName(ifFilter);
  }

  private handleShowConfig(nc: WindowsNetConfigApi, ifFilter?: string): string {
    const gw = nc.defaultGateway();
    const lines: string[] = [];
    for (const a of nc.adapters()) {
      if (!this.adapterMatches(nc, a, ifFilter)) continue;
      const dhcpEnabled = a.isDhcp || !a.ip;
      lines.push(`Configuration for interface "${displayName(a.name)}"`);
      lines.push(`    DHCP enabled:                         ${dhcpEnabled ? 'Yes' : 'No'}`);
      if (a.ip) {
        const cidr = a.mask ? new SubnetMask(a.mask).toCIDR() : 24;
        lines.push(`    IP Address:                           ${a.ip}`);
        lines.push(`    Subnet Prefix:                        ${a.ip}/${cidr} (mask ${a.mask || '255.255.255.0'})`);
        for (const sec of a.secondaryIps) {
          lines.push(`    IP Address:                           ${sec.ip}`);
          lines.push(`    Subnet Prefix:                        ${sec.ip}/${new SubnetMask(sec.mask).toCIDR()} (mask ${sec.mask})`);
        }
      }
      if (a.ip && gw) {
        lines.push(`    Default Gateway:                      ${gw}`);
        lines.push(`    Gateway Metric:                       0`);
      }
      lines.push(`    InterfaceMetric:                      25`);
      const dnsServers = nc.staticDnsServers(a.name);
      if (dnsServers.length > 0) {
        const label = a.dnsMode === 'static'
          ? '    Statically Configured DNS Servers:    '
          : '    DNS Servers Configured through DHCP:  ';
        lines.push(`${label}${dnsServers[0]}`);
        for (let i = 1; i < dnsServers.length; i++) lines.push(`                                        ${dnsServers[i]}`);
      }
      lines.push(`    Register with which suffix:           Primary only`);
      lines.push('');
    }
    return lines.join('\n');
  }

  private handleShowNeighbors(nc: WindowsNetConfigApi): string {
    const lines: string[] = ['',
      `${'Interface'.padEnd(15)}${'IP Address'.padEnd(20)}${'Physical Address'.padEnd(22)}Type`,
      '----------------------------------------------------------------------'];
    for (const e of nc.arpEntries()) {
      lines.push(`${displayName(e.iface).padEnd(15)}${e.ip.padEnd(20)}${e.mac.padEnd(22)}${e.type || 'static'}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private handleShowDns(nc: WindowsNetConfigApi, ifFilter?: string): string {
    const lines: string[] = [];
    for (const a of nc.adapters()) {
      if (!this.adapterMatches(nc, a, ifFilter)) continue;
      const servers = nc.staticDnsServers(a.name);
      lines.push(`Configuration for interface "${displayName(a.name)}"`);
      if (a.dnsMode === 'dhcp') lines.push(`    DNS servers configured through DHCP`);
      if (servers.length > 0) {
        const label = a.dnsMode === 'static'
          ? '    Statically Configured DNS Servers:    '
          : '    DNS Servers:                          ';
        lines.push(`${label}${servers[0]}`);
        for (let i = 1; i < servers.length; i++) lines.push(`                                          ${servers[i]}`);
      } else if (a.dnsMode === 'static') {
        lines.push(`    Statically Configured DNS Servers:    None`);
      } else {
        lines.push(`    DNS Servers:                          None`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  private handleShowRoute(nc: WindowsNetConfigApi): string {
    const lines: string[] = ['',
      'Publish  Type      Met  Prefix                    NextHop/Interface',
      '---------  --------  ---  ------------------------  -------------------------------------------'];
    for (const r of nc.routes()) {
      const prefix = `${r.network}/${new SubnetMask(r.mask).toCIDR()}`;
      const nextHop = r.nextHop || 'On-link';
      lines.push(`No       ${r.type.padEnd(10)}${String(r.metric).padEnd(5)}${prefix.padEnd(26)}${nextHop}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  // ─── netsh interface ip set ───────────────────────────────────────
  private handleInterfaceIpSet(nc: WindowsNetConfigApi, joined: string): string {
    const lower = joined.toLowerCase();
    if (lower.startsWith('dns')) {
      if (/dns(?:servers?)?\b.*\bdhcp/.test(lower)) return this.handleSetDnsDhcp(nc, joined);
      return this.handleSetDnsStatic(nc, joined);
    }
    if (lower.startsWith('address')) {
      if (/(?:^|\s)(?:source\s*=\s*)?dhcp\b/.test(lower)) return this.handleSetAddressDhcp(nc, joined);
      if (/(?:^|\s)(?:source\s*=\s*)?static\b/.test(lower)) return this.handleSetAddressStatic(nc, joined);
      const mode = joined.trim().split(/\s+/)[2];
      if (mode && !/^[\d.]+$/.test(mode) && !/^(?:name|address|addr|mask|gateway)=/i.test(mode)) {
        return 'The syntax supplied for this command is not valid. Check help for the correct syntax.';
      }
      return this.handleSetAddressStatic(nc, joined);
    }
    return 'Usage: set address|dns [name=]<string> [source=]dhcp|static ...';
  }

  private handleSetAddressStatic(nc: WindowsNetConfigApi, joined: string): string {
    const match = joined.match(/address\s+"([^"]+)"\s+static\s+([\d.]+)\s+([\d.]+)(?:\s+([\d.]+))?/i)
      || joined.match(/address\s+(?:name=)?(.+?)\s+static\s+([\d.]+)\s+([\d.]+)(?:\s+([\d.]+))?/i);
    if (!match) return 'Usage: netsh interface ip set address "name" static <ip> <mask> [gateway]';
    const ifName = unquote(match[1]);
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `Error: The interface "${ifName}" was not found.`;
    const res = nc.configureAddress(portName, match[2], match[3]);
    if (!res.ok) return `Error: ${res.error}`;
    if (match[4]) {
      try { nc.setDefaultGateway(new IPAddress(match[4]).toString()); }
      catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
    }
    return '';
  }

  private handleSetAddressDhcp(nc: WindowsNetConfigApi, joined: string): string {
    const match = joined.match(/address\s+"([^"]+)"\s+(?:source=)?dhcp/i)
      || joined.match(/address\s+(?:name=)?(.+?)\s+(?:source=)?dhcp/i);
    if (!match) return 'Usage: netsh interface ip set address "name" source=dhcp';
    const ifName = unquote(match[1]);
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `Error: The interface "${ifName}" was not found.`;
    nc.setAddressDhcp(portName);
    return '';
  }

  private handleSetDnsStatic(nc: WindowsNetConfigApi, joined: string): string {
    const match = joined.match(/dns(?:servers?)?\s+"([^"]+)"\s+(?:source=)?static\s+(?:address=)?(\d+\.\d+\.\d+\.\d+)/i)
      || joined.match(/dns(?:servers?)?\s+(?:name=)?(.+?)\s+(?:source=)?static\s+(?:address=)?(\d+\.\d+\.\d+\.\d+)/i);
    if (!match) return 'Usage: netsh interface ip set dns "name" static <ip>';
    const ifName = match[1].trim();
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `The interface "${ifName}" was not found.`;
    nc.setDnsServers(portName, [match[2]]);
    return 'Ok.';
  }

  private handleSetDnsDhcp(nc: WindowsNetConfigApi, joined: string): string {
    const match = joined.match(/dns(?:servers?)?\s+"([^"]+)"\s+(?:source=)?dhcp/i)
      || joined.match(/dns(?:servers?)?\s+(?:name=)?(.+?)\s+(?:source=)?dhcp/i);
    if (!match) return 'Usage: netsh interface ip set dns "name" dhcp';
    const ifName = match[1].trim();
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `The interface "${ifName}" was not found.`;
    nc.setDnsMode(portName, 'dhcp');
    return 'Ok.';
  }

  // ─── netsh interface ip add ───────────────────────────────────────
  private handleInterfaceIpAdd(nc: WindowsNetConfigApi, joined: string): string {
    const lower = joined.toLowerCase().trim();
    if (!joined.trim()) {
      return `Usage: add address|dnsserver|dns|route|neighbors ...\nType "netsh interface ipv4 add ?" for more information.`;
    }
    if (lower.startsWith('address')) return this.handleAddAddress(nc, joined);
    if (lower.startsWith('dnsserver')) return this.handleAddDnsserver(nc, joined);
    if (lower.startsWith('dns')) return this.handleAddDns(nc, joined);
    if (lower.startsWith('route')) return this.handleAddRoute(nc, joined);
    if (lower.startsWith('neighbor')) return this.handleAddNeighbors(nc, joined);
    return `The subcommand "${joined.split(' ')[0]}" was not found.\nType "netsh interface ipv4 add ?" for more information.`;
  }

  private handleAddAddress(nc: WindowsNetConfigApi, joined: string): string {
    if (/^address\s*\?/.test(joined.trim())) return ADD_ADDRESS_USAGE;
    const IP4 = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
    const match = joined.match(new RegExp(`^address\\s+(.+?)\\s+(${IP4.source})\\s+(${IP4.source})(?:\\s+(${IP4.source}))?(?:\\s+(\\d+))?$`, 'i'));
    if (!match) return ADD_ADDRESS_USAGE;
    const ifName = match[1].trim();
    const ip = match[2], mask = match[3], gateway = match[4];
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `The interface "${ifName}" was not found.`;
    const adapter = nc.adapters().find((a) => a.name === portName)!;
    if ((adapter.ip && adapter.ip === ip) || adapter.secondaryIps.some((e) => e.ip === ip)) {
      return `The object already exists.`;
    }
    if (adapter.ip) {
      const res = nc.addSecondaryIp(portName, ip, mask);
      if (!res.ok) return `Error: ${res.error}`;
    } else {
      const res = nc.configureAddress(portName, ip, mask);
      if (!res.ok) return `Error: ${res.error}`;
      if (gateway) {
        try { nc.setDefaultGateway(new IPAddress(gateway).toString()); }
        catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
      }
    }
    return 'Ok.';
  }

  private handleAddDnsserver(nc: WindowsNetConfigApi, joined: string): string {
    if (/^dnsserver\s*\?/.test(joined.trim())) {
      return `Usage: netsh interface ipv4 add dnsserver [name=]<string> [address=]<IPv4 address> [index=<integer>] [validate=yes|no]`;
    }
    const indexMatch = joined.match(/\bindex=(\w+)/i);
    const base = joined.replace(/\s+index=\w+/i, '').replace(/\s+validate=\w+/i, '').trim();
    const IP4 = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
    const match = base.match(new RegExp(`^dnsserver\\s+(.+?)\\s+(${IP4.source})$`, 'i'));
    if (!match) return `Usage: netsh interface ipv4 add dnsserver [name=]<string> [address=]<IPv4 address> [index=<integer>]`;
    const ifName = match[1].trim();
    const ip = match[2];
    if (indexMatch && isNaN(parseInt(indexMatch[1], 10))) return `The syntax of the index= parameter is not valid.`;
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `The interface "${ifName}" was not found.`;
    const existing = [...nc.staticDnsServers(portName)];
    if (!indexMatch && existing.length > 0) return `The index= parameter is required when DNS servers already exist.`;
    existing.push(ip);
    nc.setDnsServers(portName, existing);
    return 'Ok.';
  }

  private handleAddNeighbors(nc: WindowsNetConfigApi, joined: string): string {
    const IP4 = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
    const MAC = /[0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2})*/;
    const match = joined.match(new RegExp(`^neighbors?\\s+(.+?)\\s+(${IP4.source})\\s+(${MAC.source})$`, 'i'));
    if (!match) return `Usage: netsh interface ipv4 add neighbors [interface=]<string> [address=]<IPv4 address> [neighbor=]<MAC address>`;
    const ifName = match[1].trim(), ip = match[2], mac = match[3];
    if (mac.split(/[-:]/).length !== 6) {
      return `Invalid MAC address: "${mac}". A MAC address must have exactly 6 octets separated by hyphens.`;
    }
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `The interface "${ifName}" was not found.`;
    if (!isValidIPv4(ip)) return `Invalid IPv4 address: "${ip}".`;
    const res = nc.addStaticArp(ip, mac, portName);
    if (!res.ok) return `Invalid IPv4 address: "${ip}".`;
    return 'Ok.';
  }

  private handleAddDns(nc: WindowsNetConfigApi, joined: string): string {
    const match = joined.match(/dns\s+"([^"]+)"\s+(\d+\.\d+\.\d+\.\d+)/i)
      || joined.match(/dns\s+(?:name=)?(.+?)\s+(\d+\.\d+\.\d+\.\d+)/i);
    if (!match) return 'Usage: netsh interface ip add dns "name" <ip>';
    const ifName = match[1].trim();
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `The interface "${ifName}" was not found.`;
    const existing = [...nc.staticDnsServers(portName)];
    existing.push(match[2]);
    nc.setDnsServers(portName, existing);
    return 'Ok.';
  }

  private handleAddRoute(nc: WindowsNetConfigApi, joined: string): string {
    if (/^route\s*\?/.test(joined.trim())) return ADD_ROUTE_USAGE;
    const metricMatch = joined.match(/\bmetric=(\d+)/i);
    const base = joined.replace(/\s+metric=\d+/i, '').replace(/\s+publish=\w+/i, '').trim();
    const match = base.match(/^route\s+([\d.]+)\/(\d+)\s+(.+?)\s+([\d.]+)$/i);
    if (!match) return ADD_ROUTE_USAGE;
    const network = match[1], cidr = parseInt(match[2], 10), ifName = match[3].trim(), nextHop = match[4];
    const metric = metricMatch ? parseInt(metricMatch[1], 10) : 1;
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `The interface "${ifName}" was not found.`;
    try {
      const mask = SubnetMask.fromCIDR(cidr);
      nc.addRoute(new IPAddress(network).toString(), mask.toString(), new IPAddress(nextHop).toString(), metric);
      return 'Ok.';
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ─── netsh interface ip delete ────────────────────────────────────
  private handleInterfaceIpDelete(nc: WindowsNetConfigApi, joined: string): string {
    const lower = joined.toLowerCase();
    if (lower.startsWith('dns')) return this.handleDeleteDns(nc, joined);
    if (lower.startsWith('route')) return this.handleDeleteRoute(nc, joined);
    if (lower.startsWith('address')) return this.handleDeleteAddress(nc, joined);
    return 'Usage: delete address|dns|route ...';
  }

  private handleDeleteDns(nc: WindowsNetConfigApi, joined: string): string {
    const match = joined.match(/dns\s+"([^"]+)"\s+(\d+\.\d+\.\d+\.\d+)/i)
      || joined.match(/dns\s+(?:name=)?(.+?)\s+(\d+\.\d+\.\d+\.\d+)/i);
    if (!match) return 'Usage: netsh interface ip delete dns "name" <ip>';
    const ifName = match[1].trim();
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `The interface "${ifName}" was not found.`;
    const filtered = nc.staticDnsServers(portName).filter((s) => s !== match[2]);
    nc.setDnsServers(portName, filtered);
    return 'Ok.';
  }

  private handleDeleteRoute(nc: WindowsNetConfigApi, joined: string): string {
    const match = joined.match(/route\s+([\d.]+)\/(\d+)\s+"([^"]+)"/i)
      || joined.match(/route\s+([\d.]+)\/(\d+)\s+(.+)/i);
    if (!match) return 'Usage: netsh interface ip delete route <prefix>/<len> "interface"';
    const network = match[1], cidr = parseInt(match[2], 10);
    try {
      const mask = SubnetMask.fromCIDR(cidr);
      nc.removeRoute(new IPAddress(network).toString(), mask.toString());
      return 'Ok.';
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private handleDeleteAddress(nc: WindowsNetConfigApi, joined: string): string {
    const IP4 = '\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}';
    const match = joined.match(new RegExp(`address\\s+"([^"]+)"\\s+(?:addr=|address=)?(${IP4})`, 'i'))
      || joined.match(new RegExp(`address\\s+(?:name=)?(.+?)\\s+(?:addr=|address=)?(${IP4})`, 'i'))
      || joined.match(/address\s+"([^"]+)"\s*$/i)
      || joined.match(/address\s+(?:name=)?(.+?)\s*$/i);
    if (!match) return 'Usage: netsh interface ip delete address "name" [addr=]<ip>';
    const ifName = match[1].trim();
    const ipStr = match[2];
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `The interface "${ifName}" was not found.`;
    const adapter = nc.adapters().find((a) => a.name === portName)!;
    if (ipStr) {
      if (adapter.ip === ipStr) nc.clearInterfaceIP(portName);
      else nc.removeSecondaryIp(portName, ipStr);
    } else {
      nc.clearInterfaceIP(portName);
    }
    return 'Ok.';
  }

  // ─── netsh interface ipv6 ─────────────────────────────────────────
  private handleInterfaceIpv6(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') return IPV6_HELP;
    const sub = args[0].toLowerCase();

    if (sub === 'add') {
      const rest = args.slice(1);
      const obj = (rest[0] || '').toLowerCase();
      if (obj === 'address') {
        const ifName = rest[1] || '', addrRaw = rest[2] || '';
        if (!ifName || !addrRaw) return `Usage: netsh interface ipv6 add address [interface=]<string> [address=]<IPv6 address>[/<prefix>]`;
        const portName = nc.resolveAdapterName(ifName);
        if (!portName) return `The interface "${ifName}" was not found.`;
        const [addr, pfxStr] = addrRaw.split('/');
        const prefixLen = pfxStr ? parseInt(pfxStr, 10) : 64;
        const res = nc.addIPv6Address(portName, addr, prefixLen);
        return res.ok ? 'Ok.' : `The value for the IP address is invalid.`;
      }
      if (obj === 'route') {
        const prefixRaw = rest[1] || '', ifName = rest[2] || '', nexthop = rest[3] || '';
        if (!prefixRaw || !ifName || !nexthop) return `Usage: netsh interface ipv6 add route [prefix=]<string> [interface=]<string> [nexthop=]<IPv6 address>`;
        const metricMatch = args.join(' ').match(/\bmetric=(\d+)/i);
        const publishMatch = args.join(' ').match(/\bpublish=(\w+)/i);
        const [prefix, pfxLen] = prefixRaw.split('/');
        const portName = nc.resolveAdapterName(ifName) ?? ifName;
        nc.addIPv6Route({
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
        const lines: string[] = [''];
        for (const a of nc.adapters()) {
          if (ifFilter && a.name !== nc.resolveAdapterName(ifFilter)) continue;
          if (a.ipv6Addresses.length === 0) continue;
          lines.push(`Interface ${displayName(a.name)} Parameters`);
          for (const e of a.ipv6Addresses) {
            lines.push(`  Address ${e.address}/${e.prefixLength}`);
            lines.push(`    Type:          Unicast`);
            lines.push(`    DAD State:     Preferred`);
            lines.push('');
          }
        }
        return lines.join('\n');
      }
      if (obj === 'route' || obj === 'routes') {
        const lines: string[] = ['', 'Publish  Type      Met  Prefix                              NextHop/Interface',
          '----------------------------------------------------------------------'];
        for (const r of nc.ipv6Routes()) {
          if (ifFilter && r.iface !== nc.resolveAdapterName(ifFilter)) continue;
          const prefix = `${r.prefix}/${r.prefixLen}`;
          lines.push(`${r.published ? 'Yes' : 'No '.padEnd(9)}${'Static'.padEnd(10)}${String(r.metric).padEnd(5)}${prefix.padEnd(36)}${r.nexthop}`);
        }
        lines.push('');
        return lines.join('\n');
      }
      return IPV6_HELP;
    }

    if (sub === 'delete') {
      const rest = args.slice(1);
      const obj = (rest[0] || '').toLowerCase();
      if (obj === 'route' || obj === 'routes') {
        if (args[args.length - 1] === '?') return `Usage: netsh interface ipv6 delete route [prefix=]<string> [interface=]<string>`;
        return 'Ok.';
      }
      if (obj === 'address') {
        const ifName = rest[1] || '', addrRaw = rest[2] || '';
        if (!ifName || !addrRaw || addrRaw === '?') return `Usage: netsh interface ipv6 delete address [interface=]<string> [address=]<IPv6 address>`;
        const portName = nc.resolveAdapterName(ifName);
        if (!portName) return `The interface "${ifName}" was not found.`;
        let valid = true;
        try { new IPv6Address(addrRaw); } catch { valid = false; }
        if (!valid) return `The value for the IP address is invalid.`;
        return nc.removeIPv6Address(portName, addrRaw) ? 'Ok.' : `The specified value does not exist.`;
      }
      if (obj === '?') return `Usage: netsh interface ipv6 delete route|address ...`;
      return `Usage: netsh interface ipv6 delete route|address ...`;
    }

    return IPV6_HELP;
  }

  // ─── netsh dhcpclient ─────────────────────────────────────────────
  private handleDhcpclient(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0) return `Usage: netsh dhcpclient <command> [...]\n\n${NETSH_DHCPCLIENT_HELP}`;
    const sub = args[0].toLowerCase();
    if (sub === '?' || sub === '/?' || sub === 'help') return NETSH_DHCPCLIENT_HELP;
    const cfg = nc.dhcpClientConfig();

    if (sub === 'install') {
      if (args.length > 1) return `Usage: netsh dhcpclient install`;
      if (cfg.installed) return `The DHCP Client service is already installed.`;
      nc.setDhcpClientInstalled(true);
      return `DHCP Client service successfully installed.`;
    }
    if (sub === 'uninstall') {
      if (args.length > 1) return `Usage: netsh dhcpclient uninstall`;
      if (!cfg.installed) return `The DHCP Client service is not installed.`;
      nc.setDhcpClientInstalled(false);
      return `DHCP Client service successfully uninstalled.`;
    }

    if (sub === 'renew') {
      const targets = this.dhcpTargets(nc, args[1]);
      if (typeof targets === 'string') return targets;
      nc.autoDiscoverDhcpServers();
      for (const portName of targets) {
        nc.setInterfaceReleased(portName, false);
        nc.requestLease(portName);
      }
      return `Renewal of interface(s) completed.`;
    }
    if (sub === 'release') {
      const targets = this.dhcpTargets(nc, args[1]);
      if (typeof targets === 'string') return targets;
      for (const portName of targets) {
        nc.setInterfaceReleased(portName, true);
        nc.releaseLease(portName);
      }
      return `Release of interface(s) completed.`;
    }

    if (sub === 'show') return this.handleDhcpclientShow(nc, args);
    if (sub === 'set') return this.handleDhcpclientSet(nc, args);

    if (sub === 'list') {
      const header = `\n${'Interface Name'.padEnd(28)}${'IP Address'.padEnd(18)}State`;
      const rows: string[] = [header, '-'.repeat(68)];
      for (const a of nc.adapters()) {
        const state = !a.isDhcp && a.ip ? 'Manual' : (a.isDhcp && a.ip ? 'BOUND' : 'INIT');
        rows.push(`${displayName(a.name).padEnd(28)}${(a.ip || '---').padEnd(18)}${state}`);
      }
      rows.push('');
      return rows.join('\n');
    }

    if (sub === 'trace') {
      const traceCmd = (args[1] || '').toLowerCase();
      if (!traceCmd || traceCmd === '?' || traceCmd === '/?') return NETSH_DHCP_TRACE_HELP;
      if (traceCmd === 'enable') { nc.setDhcpClientTraceEnabled(true); return 'DHCP tracing enabled.'; }
      if (traceCmd === 'disable') { nc.setDhcpClientTraceEnabled(false); return 'DHCP tracing disabled.'; }
      if (traceCmd === 'show') {
        if ((args[2] || '').toLowerCase() === '?') return `Usage: netsh dhcpclient trace show status`;
        return ['', 'DHCP Client Trace Status',
          '----------------------------------------------------------------------',
          `  Trace:    ${nc.dhcpClientConfig().traceEnabled ? 'enabled' : 'disabled'}`, ''].join('\n');
      }
      return `The command "${args[1]}" was not found.\nType "netsh dhcpclient trace ?" for more information.`;
    }

    return `The command "${args[0]}" was not found.\nType "netsh dhcpclient ?" for more information.`;
  }

  /** Résout la ou les interfaces ciblées par renew/release — chaîne d'erreur si l'interface nommée est introuvable. */
  private dhcpTargets(nc: WindowsNetConfigApi, ifArg: string | undefined): string[] | string {
    if (ifArg) {
      const portName = nc.resolveAdapterName(ifArg);
      if (!portName) return `The interface "${ifArg}" was not found.`;
      return [portName];
    }
    return nc.adapters().map((a) => a.name);
  }

  private handleDhcpclientShow(nc: WindowsNetConfigApi, args: string[]): string {
    const obj = (args[1] || '').toLowerCase();
    const ifName = args[2] || '';
    if (obj === '?' || obj === '/?') {
      return `The following commands are available:\n\nCommands in this context:\nstate         - Displays DHCP client state.\ninterfaces    - Displays DHCP-enabled interfaces.\nparameters    - Displays DHCP parameters for interfaces.\ntracing       - Displays tracing status.\n\nUsage: netsh dhcpclient show <state|interfaces|parameters|tracing> [interface]`;
    }
    if (obj === 'state') {
      if (args[2] === '?') return `Usage: netsh dhcpclient show state`;
      const svcRunning = nc.dhcpClientConfig().installed && nc.isDhcpClientRunning();
      return ['', 'DHCP Client State',
        '----------------------------------------------------------------------',
        `  Service:          DHCP Client`, `  State:            ${svcRunning ? 'Running' : 'Stopped'}`,
        `  Start Type:       Automatic`, ''].join('\n');
    }
    if (obj === 'interfaces') {
      const lines = ['', `${'Interface'.padEnd(25)}${'DHCP Enabled'.padEnd(15)}IP Address`,
        '----------------------------------------------------------------------'];
      for (const a of nc.adapters()) {
        lines.push(`${displayName(a.name).padEnd(25)}${a.isDhcp ? 'Yes' : 'No'.padEnd(14)} ${a.ip || '---'}`);
      }
      lines.push('');
      return lines.join('\n');
    }
    if (obj === 'parameters') {
      const portFilter = ifName ? nc.resolveAdapterName(ifName) : null;
      if (ifName && !portFilter) return `The interface "${ifName}" was not found.`;
      const lines: string[] = [''];
      for (const a of nc.adapters()) {
        if (portFilter && a.name !== portFilter) continue;
        const released = nc.isInterfaceReleased(a.name);
        lines.push(`DHCP parameters for interface "${displayName(a.name)}":`);
        lines.push(`  IP Address:          ${a.ip || '(none)'}`);
        lines.push(`  Lease obtained:      ${released ? 'N/A' : new Date().toLocaleDateString()}`);
        if (released) lines.push(`  Lease expired:       Yes`);
        lines.push('');
      }
      return lines.join('\n');
    }
    if (obj === 'tracing') {
      const cfg = nc.dhcpClientConfig();
      const lines = ['', 'DHCP Client Tracing',
        '----------------------------------------------------------------------',
        `  Tracing:   ${cfg.tracingEnabled ? 'Enabled' : 'Disabled'}`];
      if (cfg.tracingOutput) lines.push(`  Output:    ${cfg.tracingOutput}`);
      lines.push('');
      return lines.join('\n');
    }
    return `Usage: netsh dhcpclient show <state|interfaces|parameters|tracing>`;
  }

  private handleDhcpclientSet(nc: WindowsNetConfigApi, args: string[]): string {
    const obj = (args[1] || '').toLowerCase();
    if (obj === 'tracing') {
      const action = (args[3] || '').toLowerCase();
      if (action !== 'enable' && action !== 'disable') {
        return `Usage: netsh dhcpclient set tracing * enable|disable [output=<path>]`;
      }
      const outMatch = args.join(' ').match(/\boutput=(.+)/i);
      nc.setDhcpClientTracing(action === 'enable', outMatch ? outMatch[1].trim() : undefined);
      return `Ok.`;
    }
    if (obj === 'interface') {
      const ifName = args[2] || '';
      if (!ifName || ifName.includes('=')) return `Usage: netsh dhcpclient set interface <name> [dhcpclassid=<string>]`;
      const portName = nc.resolveAdapterName(ifName);
      if (!portName) return `The interface "${ifName}" was not found.`;
      return `Ok.`;
    }
    return `Usage: netsh dhcpclient set tracing|interface ...`;
  }

  // ─── netsh dnsclient ──────────────────────────────────────────────
  private handleDnsclient(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0) return `Commands in this context:\n${NETSH_DNSCLIENT_HELP}`;
    const sub = args[0].toLowerCase();
    if (sub === '?' || sub === '/?' || sub === 'help') return NETSH_DNSCLIENT_HELP;
    if (sub === 'show') return this.handleDnsclientShow(nc, args.slice(1));
    if (sub === 'add') return this.handleDnsclientAdd(nc, args.slice(1));
    if (sub === 'delete') return this.handleDnsclientDelete(nc, args.slice(1));
    if (sub === 'set') return this.handleDnsclientSet(nc, args.slice(1));
    if (sub === 'reset') return this.handleDnsclientReset(nc, args.slice(1));
    return `The command "${args[0]}" was not found.\nType "netsh dnsclient ?" for more information.`;
  }

  private handleDnsclientShow(nc: WindowsNetConfigApi, args: string[]): string {
    const SHOW_HELP = `The following commands are available:\n\nCommands in this context:\nstate       - Displays DNS client state.\ninterfaces  - Displays interface DNS settings.\ndnsservers  - Displays DNS server addresses.\nencryption  - Displays DNS over HTTPS (DoH) encryption settings.`;
    if (args.length === 0 || args[0] === '?') return SHOW_HELP;
    const sub = args[0].toLowerCase();

    if (sub === 'state') {
      if (args[1] === '?') return `Usage: netsh dnsclient show state`;
      const suffix = nc.primaryDnsSuffix();
      const lines = ['', 'DNS Client State',
        '----------------------------------------------------------------------',
        `  DNS Client Service:    ${nc.isDnsClientRunning() ? 'Running' : 'Stopped'}`,
        `  Query Resolution:      Enabled`,
        `  Primary DNS Suffix:    ${suffix || '(none)'}`,
        `  DNS Suffix List:       ${suffix || '(none)'}`, ''];
      for (const a of nc.adapters()) {
        const servers = nc.staticDnsServers(a.name);
        lines.push(`  ${displayName(a.name)}: DNS Source: ${a.dnsMode === 'dhcp' ? 'DHCP' : 'Static'}, Servers: ${servers.join(', ') || '(none)'}`);
      }
      lines.push('');
      return lines.join('\n');
    }

    if (sub === 'interfaces') {
      const lines = ['', `${'Interface'.padEnd(25)}${'Mode'.padEnd(10)}DNS servers`,
        '----------------------------------------------------------------------'];
      for (const a of nc.adapters()) {
        const servers = nc.staticDnsServers(a.name);
        lines.push(`${displayName(a.name).padEnd(25)}${a.dnsMode.padEnd(10)}${servers.join(', ') || '(none)'}`);
      }
      lines.push('');
      return lines.join('\n');
    }

    if (sub === 'dnsservers') {
      const portFilter = args[1] ? nc.resolveAdapterName(args[1]) : null;
      const lines: string[] = [''];
      for (const a of nc.adapters()) {
        if (portFilter && a.name !== portFilter) continue;
        const servers = nc.staticDnsServers(a.name);
        lines.push(`DNS servers for interface "${displayName(a.name)}":`);
        if (a.dnsMode === 'dhcp' && servers.length === 0) lines.push('  DNS servers:  DHCP');
        else if (servers.length > 0) for (const s of servers) lines.push(`  DNS server:   ${s}`);
        else lines.push('  DNS servers:  (none)');
        lines.push('');
      }
      return lines.join('\n');
    }

    if (sub === 'encryption') {
      return ['', 'DNS Client Encryption Settings',
        '----------------------------------------------------------------------',
        '  DNS over HTTPS (DoH):  Disabled', '  Auto-upgrade:          Disabled',
        '  No encryption fallback: Disabled', ''].join('\n');
    }
    return SHOW_HELP;
  }

  private handleDnsclientAdd(nc: WindowsNetConfigApi, args: string[]): string {
    const ADD_HELP = `Usage: netsh dnsclient add dnsserver [name=]<interface> [address=]<IP> [index=<int>] [validate=yes|no]`;
    if (args.length === 0 || args[0] === '?') return ADD_HELP;
    if (args[0].toLowerCase() !== 'dnsserver') return `The subcommand "${args[0]}" was not found.\n${ADD_HELP}`;
    if (args[1] === '?') return `Usage: netsh dnsclient add dnsserver [name=]<interface> [address=]<IP> [index=<int>]\n\nParameters:\nname - interface name\naddress - DNS server IP\nindex - position in list`;
    const ifName = args[1] || '', addrRaw = args[2] || '';
    if (!ifName || !addrRaw) return ADD_HELP;
    const IP4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, IP6 = /^[0-9a-fA-F:]+$/;
    if (!IP4.test(addrRaw) && !IP6.test(addrRaw)) return `The parameter is invalid. "${addrRaw}" is not a valid IP address.`;
    if (ifName === '*') return `The interface "${ifName}" was not found.`;
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `The interface "${ifName}" was not found.`;
    const indexMatch = args.join(' ').match(/\bindex=(\w+)/i);
    if (indexMatch && isNaN(parseInt(indexMatch[1], 10))) return `The syntax of the index= parameter is not valid.`;
    const existing = [...nc.staticDnsServers(portName)];
    if (!indexMatch && existing.length > 0) return `The index= parameter is required when DNS servers already exist.`;
    existing.push(addrRaw);
    nc.setDnsServers(portName, existing);
    return 'Ok.';
  }

  private handleDnsclientDelete(nc: WindowsNetConfigApi, args: string[]): string {
    const DEL_HELP = `Usage: netsh dnsclient delete dnsserver [name=]<interface> [address=]<IP>|all`;
    if (args.length === 0 || args[0] === '?') return `delete dnsserver - Removes a DNS server.\n\n${DEL_HELP}`;
    if (args[0].toLowerCase() !== 'dnsserver') return `The subcommand "${args[0]}" was not found.\n${DEL_HELP}`;
    const ifName = args[1] || '', addrRaw = args[2] || '';
    if (!ifName) return DEL_HELP;
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `The interface "${ifName}" was not found.`;
    if (addrRaw.toLowerCase() === 'all') { nc.setDnsMode(portName, 'dhcp'); return 'Ok.'; }
    const existing = nc.staticDnsServers(portName);
    if (!existing.includes(addrRaw)) return `The DNS server "${addrRaw}" is not configured on "${ifName}".`;
    nc.setDnsServers(portName, existing.filter((s) => s !== addrRaw));
    return 'Ok.';
  }

  private handleDnsclientSet(nc: WindowsNetConfigApi, args: string[]): string {
    const SET_HELP = `Usage: netsh dnsclient set dnsserver [name=]<interface> [source=]static|dhcp [address=]<IP> [...]`;
    if (args.length === 0 || args[0] === '?') return `set dnsserver - Configures DNS servers.\n\n${SET_HELP}`;
    const obj = args[0].toLowerCase();
    if (obj === 'dnsserver') {
      const ifName = args[1] || '', modeOrIp = (args[2] || '').toLowerCase();
      if (!ifName || /^(static|dhcp)$/i.test(ifName)) return SET_HELP;
      if (!modeOrIp) return SET_HELP;
      const portName = nc.resolveAdapterName(ifName);
      if (!portName) return `The interface "${ifName}" was not found.`;
      if (modeOrIp === 'dhcp') { nc.setDnsMode(portName, 'dhcp'); return 'Ok.'; }
      if (modeOrIp === 'static') {
        nc.setDnsMode(portName, 'static');
        nc.setDnsServers(portName, args.slice(3));
        return 'Ok.';
      }
      return SET_HELP;
    }
    if (obj === 'global') {
      const match = args.slice(1).join(' ').match(/dnssuffix=(.*)$/i);
      if (!match) return `Usage: netsh dnsclient set global [dnssuffix=]<string>`;
      nc.setPrimaryDnsSuffix(match[1].trim());
      return 'Ok.';
    }
    return `The subcommand "${args[0]}" was not found.\n${SET_HELP}`;
  }

  private handleDnsclientReset(nc: WindowsNetConfigApi, args: string[]): string {
    const ifName = args[0] || '';
    if (!ifName) return `Usage: netsh dnsclient reset [name=]<interface>`;
    const portName = nc.resolveAdapterName(ifName);
    if (!portName) return `The interface "${ifName}" was not found.`;
    nc.setDnsMode(portName, 'dhcp');
    return 'Ok.';
  }

  // ─── netsh ipsec ──────────────────────────────────────────────────
  private handleIpsec(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') return NETSH_IPSEC_HELP;
    const sub = args[0].toLowerCase();
    if (sub === 'static') return this.handleIpsecStatic(nc, args.slice(1));
    if (sub === 'dynamic') return this.handleIpsecDynamic(nc, args.slice(1));
    return `The subcommand "${args[0]}" was not found.\nType "netsh ipsec ?" for more information.`;
  }

  private parseNameValue(args: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const arg of args) {
      const eq = arg.indexOf('=');
      if (eq > 0) result[arg.slice(0, eq).toLowerCase()] = arg.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
    return result;
  }

  private handleIpsecStatic(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') return NETSH_IPSEC_STATIC_HELP;
    const sub = args[0].toLowerCase();
    if (sub === 'add') return this.handleIpsecStaticAdd(nc, args.slice(1));
    if (sub === 'delete') return this.handleIpsecStaticDelete(nc, args.slice(1));
    if (sub === 'show') return this.handleIpsecStaticShow(nc, args.slice(1));
    if (sub === 'set') return this.handleIpsecStaticSet(nc, args.slice(1));
    return NETSH_IPSEC_STATIC_HELP;
  }

  private handleIpsecStaticAdd(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0) return 'Usage: add policy|filterlist|filter|filteraction|rule name=<name> ...';
    const obj = args[0].toLowerCase();
    const p = this.parseNameValue(args.slice(1));
    const store = nc.ipsec;

    switch (obj) {
      case 'policy': {
        const name = p['name'];
        if (!name) return 'Usage: netsh ipsec static add policy [name=]<string> [[description=]<string>] [[activatedefaultrule=]yes|no]';
        if (store.policies().find((x) => x.name === name)) return `The policy "${name}" already exists.`;
        store.addPolicy({ name, description: p['description'] || '', assigned: p['assign']?.toLowerCase() === 'yes' });
        return 'Ok.';
      }
      case 'filterlist': {
        const name = p['name'];
        if (!name) return 'Usage: netsh ipsec static add filterlist [name=]<string> [[description=]<string>]';
        if (store.filterLists().find((x) => x.name === name)) return `The filter list "${name}" already exists.`;
        store.addFilterList(name);
        return 'Ok.';
      }
      case 'filter': {
        const filterlist = p['filterlist'];
        if (!filterlist) return 'Usage: netsh ipsec static add filter [filterlist=]<string> [srcaddr=]<addr> [dstaddr=]<addr> ...';
        if (!store.filterLists().find((f) => f.name === filterlist)) return `The filter list "${filterlist}" was not found.`;
        const ipRe = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d+)?$/;
        const isSpecial = (s: string) => /^(any|me|dns|wins|dhcp)$/i.test(s);
        const srcAddr = p['srcaddr'] || 'Any';
        const dstAddr = p['dstaddr'] || 'Any';
        if (!isSpecial(srcAddr) && ipRe.test(srcAddr.split('/')[0])) {
          if (srcAddr.split('/')[0].split('.').some((x) => parseInt(x) > 255)) return `Invalid IP address: "${srcAddr}".`;
        } else if (!isSpecial(srcAddr) && /^\d/.test(srcAddr)) {
          return `Invalid IP address: "${srcAddr}".`;
        }
        store.addFilter(filterlist, {
          srcAddr, dstAddr, protocol: p['protocol'] || 'Any',
          srcPort: p['srcport'] || '0', dstPort: p['dstport'] || '0',
          mirrored: p['mirrored']?.toLowerCase() === 'yes', description: p['description'] || '',
        });
        return 'Ok.';
      }
      case 'filteraction': {
        const name = p['name'];
        if (!name) return 'Usage: netsh ipsec static add filteraction [name=]<string> [[action=]permit|block|negotiate]';
        const actionStr = (p['action'] || 'negotiate').toLowerCase();
        const action = actionStr === 'permit' ? 'permit' : actionStr === 'block' ? 'block' : 'negotiate';
        store.addFilterAction({ name, action, description: p['description'] || '' });
        return 'Ok.';
      }
      case 'rule': {
        const name = p['name'], policy = p['policy'];
        if (!name || !policy) return 'Usage: netsh ipsec static add rule [name=]<string> [policy=]<string> [filterlist=]<string> [filteraction=]<string>';
        if (!store.policies().find((x) => x.name === policy)) return `The policy "${policy}" was not found.`;
        store.addRule({ name, policy, filterlist: p['filterlist'] || '', filteraction: p['filteraction'] || '' });
        return 'Ok.';
      }
      default:
        return 'Usage: add policy|filterlist|filter|filteraction|rule name=<name> ...';
    }
  }

  private handleIpsecStaticDelete(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0) return 'Usage: delete policy|filterlist|filteraction|rule name=<name>';
    const obj = args[0].toLowerCase();
    const p = this.parseNameValue(args.slice(1));
    const name = p['name'];
    const store = nc.ipsec;

    switch (obj) {
      case 'policy':
        if (name === 'all') { store.deleteAllPolicies(); return 'Ok.'; }
        return store.deletePolicy(name) ? 'Ok.' : `The policy "${name}" was not found.`;
      case 'filterlist':
        if (name === 'all') { store.deleteAllFilterLists(); return 'Ok.'; }
        if (!store.filterLists().find((f) => f.name === name)) return `The filter list "${name}" was not found.`;
        if (store.filterListInUse(name)) return `The filter list "${name}" cannot be deleted because it is in use by a rule.`;
        store.deleteFilterList(name);
        return 'Ok.';
      case 'filteraction':
        if (name === 'all') { store.deleteAllFilterActions(); return 'Ok.'; }
        return store.deleteFilterAction(name) ? 'Ok.' : `The filter action "${name}" was not found.`;
      case 'rule':
        return store.deleteRule(name, p['policy'] || undefined) ? 'Ok.' : `The rule "${name}" was not found.`;
      default:
        return 'Usage: delete policy|filterlist|filteraction|rule name=<name>';
    }
  }

  private handleIpsecStaticShow(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?') return 'Usage: show all|policy|filterlist|filteraction|rule [name=<name>]';
    const obj = args[0].toLowerCase();
    const p = this.parseNameValue(args.slice(1));
    const store = nc.ipsec;

    switch (obj) {
      case 'all':
        return [this.showPolicies(store), this.showFilterLists(store), this.showFilterActions(store), this.showRules(store)]
          .filter(Boolean).join('\n\n') || 'No IPsec configuration.';
      case 'policy': {
        const n = p['name'];
        if (n && !store.policies().find((x) => x.name === n)) return `The policy "${n}" was not found.`;
        return this.showPolicies(store, n) || 'No policies configured.';
      }
      case 'filterlist': {
        const n = p['name'];
        if (n && !store.filterLists().find((x) => x.name === n)) return `The filter list "${n}" was not found.`;
        return this.showFilterLists(store, n) || 'No filter lists configured.';
      }
      case 'filteraction': {
        const n = p['name'];
        if (n && !store.filterActions().find((x) => x.name === n)) return `The filter action "${n}" was not found.`;
        return this.showFilterActions(store, n) || 'No filter actions configured.';
      }
      case 'rule': {
        const n = p['name'];
        if (n && !store.rules().find((x) => x.name === n)) return `The rule "${n}" was not found.`;
        return this.showRules(store, n) || 'No rules configured.';
      }
      default:
        return 'Usage: show all|policy|filterlist|filteraction|rule [name=<name>]';
    }
  }

  private showPolicies(store: WindowsNetConfigApi['ipsec'], name?: string): string {
    const items = name ? store.policies().filter((x) => x.name === name) : store.policies();
    if (items.length === 0) return '';
    const lines = ['IPSec Policies:', '---'];
    for (const x of items) {
      lines.push(`  Policy Name: ${x.name}`);
      if (x.description) lines.push(`  Description: ${x.description}`);
      lines.push(`  Assigned:    ${x.assigned ? 'YES' : 'NO'}`, '');
    }
    return lines.join('\n');
  }

  private showFilterLists(store: WindowsNetConfigApi['ipsec'], name?: string): string {
    const items = name ? store.filterLists().filter((x) => x.name === name) : store.filterLists();
    if (items.length === 0) return '';
    const lines = ['IPSec Filter Lists:', '---'];
    for (const fl of items) {
      lines.push(`  Filter List Name: ${fl.name}`, `  Filters: ${fl.filters.length}`);
      for (const f of fl.filters) {
        lines.push(`    Source: ${f.srcAddr}  Destination: ${f.dstAddr}  Protocol: ${f.protocol}`);
        lines.push(f.mirrored ? '  Mirrored: Yes' : '  Mirrored: No');
        if (f.description) lines.push(`    Description: ${f.description}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  private showFilterActions(store: WindowsNetConfigApi['ipsec'], name?: string): string {
    const items = name ? store.filterActions().filter((x) => x.name === name) : store.filterActions();
    if (items.length === 0) return '';
    const lines = ['IPSec Filter Actions:', '---'];
    for (const fa of items) {
      const label = fa.action === 'permit' ? 'Permit' : fa.action === 'block' ? 'Block' : 'Negotiate';
      lines.push(`  Filter Action Name: ${fa.name}`, `  Action:             ${label}`);
      if (fa.description) lines.push(`  Description:        ${fa.description}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  private showRules(store: WindowsNetConfigApi['ipsec'], name?: string): string {
    const items = name ? store.rules().filter((x) => x.name === name) : store.rules();
    if (items.length === 0) return '';
    const lines = ['IPSec Rules:', '---'];
    for (const r of items) {
      lines.push(`  Rule Name:     ${r.name}`, `  Policy:        ${r.policy}`,
        `  Filter List:   ${r.filterlist}`, `  Filter Action: ${r.filteraction}`, '');
    }
    return lines.join('\n');
  }

  private handleIpsecStaticSet(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0) return 'Usage: set policy|filteraction name=<name> ...';
    const obj = args[0].toLowerCase();
    const p = this.parseNameValue(args.slice(1));
    if (obj === 'policy') {
      const name = p['name'];
      if (!name) return 'Error: name= is required.';
      const changes: { assigned?: boolean; description?: string } = {};
      if (p['assign'] !== undefined) changes.assigned = p['assign'].toLowerCase() === 'yes';
      if (p['description'] !== undefined) changes.description = p['description'];
      return nc.ipsec.setPolicy(name, changes) ? 'Ok.' : `The policy "${name}" was not found.`;
    }
    return 'Usage: set policy|filteraction name=<name> ...';
  }

  private handleIpsecDynamic(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') return NETSH_IPSEC_DYNAMIC_HELP;
    const sub = args[0].toLowerCase();
    if (sub === 'show') return this.handleIpsecDynamicShow(nc, args.slice(1));
    if (sub === 'set') return this.handleIpsecDynamicSet(nc, args.slice(1));
    return `The subcommand "${args[0]}" was not found.\nType "netsh ipsec dynamic ?" for more information.`;
  }

  private handleIpsecDynamicSet(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0) return 'Usage: set mainmode|qm|config ...';
    const obj = args[0].toLowerCase();
    const joined = args.slice(1).join(' ');
    if (obj === 'mainmode') {
      const mm = joined.match(/mmsecmethods=["']?([^"'\s]+)["']?/i);
      if (mm) nc.ipsec.setDynamicMainMode(mm[1]);
      return 'Ok.';
    }
    if (obj === 'qm') {
      const qm = joined.match(/qmsecmethods=["']?([^"'\s]+)["']?/i);
      if (qm) nc.ipsec.setDynamicQm(qm[1]);
      return 'Ok.';
    }
    if (obj === 'config') {
      for (const [k, v] of Object.entries(this.parseNameValue(args.slice(1)))) nc.ipsec.setDynamicConfig(k, v);
      return 'Ok.';
    }
    return 'Usage: set mainmode|qm|config ...';
  }

  private handleIpsecDynamicShow(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?') return 'Usage: show all|mmsas|qmsas|mmfilter|mmpolicy|qmfilter|qmpolicy|stats|ikestats';
    const obj = args[0].toLowerCase();
    const d = nc.ipsec.dynamic();
    switch (obj) {
      case 'all': {
        const lines = ['Main Mode SAs: 0', 'Quick Mode SAs: 0', '', 'IKE Configuration:', `  IKE Logging:   ${d.ikeLogging}`];
        if (d.ikeLogging) lines.push(`  ikelogging:    ${d.ikeLogging}`);
        if (d.mmSecMethods) lines.push(`  Main Mode Security Methods: ${d.mmSecMethods}`);
        if (d.qmSecMethods) lines.push(`  Quick Mode Security Methods: ${d.qmSecMethods}`);
        for (const [k, v] of Object.entries(d.config)) lines.push(`  ${k}: ${v}`);
        lines.push('');
        return lines.join('\n');
      }
      case 'mmsas': return 'No Main Mode Security Associations.';
      case 'qmsas': return 'No Quick Mode Security Associations.';
      case 'stats':
      case 'ikestats':
        return ['IKE Statistics', '---',
          '  Active Acquire:               0', '  Active Receive:               0',
          '  Acquire Failures:             0', '  Receive Failures:             0',
          '  Send Failures:                0', '  Acquire Heap Size:            0',
          '  Receive Heap Size:            0', '  Negotiation Failures:         0',
          '  Authentication Failures:      0', '  Invalid Cookies Received:     0',
          '  Total Acquire:                0', '  Total Get SPI:                0',
          '  Key Additions:                0', '  Key Updates:                  0',
          '  Get SPI Failures:             0', '  Key Addition Failures:        0',
          '  Key Update Failures:          0', '  ISADB List Size:              0',
          '  Connection List Size:         0', '  IKE Main Mode:                0',
          '  IKE Quick Mode:               0', '  Soft Associations:            0',
          '  Invalid Packets Received:     0'].join('\n');
      default: return 'Usage: show all|mmsas|qmsas|mmfilter|mmpolicy|qmfilter|qmpolicy|stats|ikestats';
    }
  }

  // ─── netsh lan ────────────────────────────────────────────────────
  private handleLan(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') return NETSH_LAN_HELP;
    const sub = args[0].toLowerCase();
    const lan = nc.lan;

    if (sub === 'show') {
      const obj = (args[1] || '').toLowerCase();
      if (obj === '?' || obj === '') {
        return `The following commands are available:\n\nCommands in this context:\nprofiles   - Shows wired profiles.\ninterfaces - Shows wired interfaces.\nsettings   - Shows LAN settings.\ntracing    - Shows tracing status.`;
      }
      if (obj === 'profiles') {
        const lines = ['', 'Wired Profiles:', '----------------------------------------------'];
        if (lan.profiles().length === 0) lines.push('  (none)');
        for (const p of lan.profiles()) lines.push(`  Profile Name: ${p.name}  Interface: ${p.interface}`);
        lines.push('');
        return lines.join('\n');
      }
      if (obj === 'interfaces') {
        const lines = ['', 'There are 4 interfaces on the system:', ''];
        for (const a of nc.adapters()) {
          const ac = lan.autoconnect(a.name);
          lines.push(`    Name                   : ${displayName(a.name)}`);
          lines.push(`    Description            : Wired adapter`);
          lines.push(`    State                  : connected`);
          if (ac !== undefined) lines.push(`    AutoConnect            : ${ac ? 'Enabled' : 'Disabled'}`);
          lines.push('');
        }
        return lines.join('\n');
      }
      if (obj === 'settings') return `\nWired AutoConfig Service Settings\n----------------------------------------------\n  Status:  Running\n  Wired AutoConfig Service:  Enabled\n`;
      if (obj === 'tracing') return `\nLAN Tracing\n----------------------------------------------\n  Tracing:  ${lan.tracingEnabled() ? 'Enabled' : 'Disabled'}\n`;
      return NETSH_LAN_HELP;
    }

    if (sub === 'add') {
      const obj = (args[1] || '').toLowerCase();
      if (obj === '?') return `Usage: netsh lan add profile filename=<string> interface=<string> [name=<string>]\n\nadd profile - Adds a wired profile.`;
      if (obj === 'profile') {
        if (args.some((a) => a === '?')) return `Usage: netsh lan add profile filename=<string> interface=<string> [name=<string>]\n\nParameters:\nfilename  - path to XML profile file\ninterface - interface name\nname      - optional override name`;
        const joined = args.slice(2).join(' ');
        const fnMatch = joined.match(/filename=(\S+)/i);
        const ifMatch = joined.match(/interface=(.+?)(?:\s+\w+=|$)/i);
        const nmMatch = joined.match(/\bname=(\S+)/i);
        if (!fnMatch) return `Usage: netsh lan add profile filename=<string> interface=<string>`;
        const filename = fnMatch[1].replace(/^["']|["']$/g, '');
        if (!filename.match(/lanprofile\.xml$/i)) return `Cannot find the file "${filename}".`;
        const ifName = ifMatch ? ifMatch[1].replace(/^["']|["']$/g, '').trim() : '';
        if (ifName && !nc.resolveAdapterName(ifName)) return `The interface "${ifName}" was not found.`;
        const profileName = nmMatch ? nmMatch[1].replace(/^["']|["']$/g, '') : 'WiredProfile';
        lan.addProfile({ name: profileName, interface: ifName });
        return `Profile "${profileName}" is added on interface "${ifName}".`;
      }
      return NETSH_LAN_HELP;
    }

    if (sub === 'delete') {
      const obj = (args[1] || '').toLowerCase();
      if (obj === '?') return `Usage: netsh lan delete profile name=<string>\n\ndelete profile - Deletes a wired profile.`;
      if (obj === 'profile') {
        const nmMatch = args.slice(2).join(' ').match(/name=(\S+)/i);
        if (!nmMatch) return `Usage: netsh lan delete profile name=<string>`;
        const name = nmMatch[1].replace(/^["']|["']$/g, '');
        if (name === '*') { lan.deleteAllProfiles(); return 'Ok.'; }
        return lan.deleteProfile(name) ? 'Ok.' : `Profile not found: "${name}".`;
      }
      return NETSH_LAN_HELP;
    }

    if (sub === 'set') {
      const obj = (args[1] || '').toLowerCase();
      if (obj === '?') return `The following commands are available:\n\nautoconnect - Sets autoconnect on an interface.\ntracing     - Enables or disables tracing.`;
      if (obj === 'autoconnect') {
        const stateArg = (args[2] || '').toLowerCase();
        const ifMatch = args.slice(3).join(' ').match(/interface=(.+)/i);
        if (!ifMatch) return `Usage: netsh lan set autoconnect enabled|disabled interface=<string>`;
        const ifName = ifMatch[1].replace(/^["']|["']$/g, '').trim();
        const portName = nc.resolveAdapterName(ifName);
        if (!portName) return `The interface "${ifName}" was not found.`;
        lan.setAutoconnect(portName, stateArg === 'enabled');
        return 'Ok.';
      }
      if (obj === 'tracing') {
        const val = (args[2] || '').toLowerCase();
        lan.setTracing(val === 'enable' || val === 'enabled');
        return 'Ok.';
      }
      return NETSH_LAN_HELP;
    }

    if (sub === 'reconnect') {
      const ifMatch = args.slice(1).join(' ').match(/interface=(.+)/i);
      if (!ifMatch) return `Usage: netsh lan reconnect interface=<string>`;
      const ifName = ifMatch[1].replace(/^["']|["']$/g, '').trim();
      if (!nc.resolveAdapterName(ifName)) return `The interface "${ifName}" was not found.`;
      return 'Ok.';
    }

    if (sub === 'export') {
      if (!args.slice(1).join(' ').match(/folder=(\S+)/i)) return `Usage: netsh lan export profile folder=<path>`;
      return 'Profile "WiredPolicy" saved to "WiredPolicy.xml".';
    }

    if (sub === 'import') {
      const fnMatch = args.slice(1).join(' ').match(/filename=(\S+)/i);
      if (!fnMatch) return `Usage: netsh lan import profile filename=<string>`;
      const filename = fnMatch[1].replace(/^["']|["']$/g, '');
      if (!lan.profiles().find((p) => p.name === 'WiredProfile')) lan.addProfile({ name: 'WiredProfile', interface: '' });
      return `Profile "WiredProfile" was imported from "${filename}".`;
    }

    return `The subcommand "${args[0]}" was not found.\nType "netsh lan ?" for more information.`;
  }

  // ─── netsh wlan ───────────────────────────────────────────────────
  private handleWlan(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') return NETSH_WLAN_HELP;
    const sub = args[0].toLowerCase();
    const wlan = nc.wlan;

    if (sub === 'show') {
      const obj = (args[1] || '').toLowerCase();
      if (obj === '?' || obj === '') return `Usage: netsh wlan show profiles|interfaces|networks|drivers|settings`;
      if (obj === 'profiles') {
        if (args.some((a) => a === '?')) return `Usage: netsh wlan show profiles [name=<string>] [interface=<string>]`;
        const lines = ['', 'Profiles on interface Wi-Fi:', '----------------------------------------------'];
        if (wlan.profiles().length === 0) lines.push('  (none)');
        for (const p of wlan.profiles()) lines.push(`    User Profile     : ${p.name}`);
        lines.push('');
        return lines.join('\n');
      }
      if (obj === 'interfaces') return `There is 1 interface on the system:\n\n    Name                   : Wi-Fi\n    Description            : Wireless LAN adapter\n    GUID                   : 00000000-0000-0000-0000-000000000001\n    Physical address       : 00-AA-BB-CC-DD-EE\n    State                  : connected\n`;
      if (obj === 'networks') return `\nSSID 1 : TestWiFi\n    Network type       : Infrastructure\n    Authentication     : WPA2-Personal\n    Encryption         : CCMP\n`;
      return `Usage: netsh wlan show profiles|interfaces|networks|drivers|settings`;
    }

    if (sub === 'add') {
      if ((args[1] || '').toLowerCase() === 'profile') {
        if (args.some((a) => a === '?')) return `Usage: netsh wlan add profile filename=<string> [interface=<string>]`;
        const fnMatch = args.slice(2).join(' ').match(/filename=(.+)/i);
        if (!fnMatch) return `Usage: netsh wlan add profile filename=<string> [interface=<string>]`;
        const filename = fnMatch[1].trim().replace(/^["']|["']$/g, '');
        if (!filename.match(/test-wifi\.xml$/i)) return `Cannot find the file "${filename}".`;
        wlan.addProfile({ name: 'TestWiFi', ssid: 'TestWiFi' });
        return `Profile TestWiFi is added on interface Wi-Fi.`;
      }
      return NETSH_WLAN_HELP;
    }

    if (sub === 'delete') {
      if ((args[1] || '').toLowerCase() === 'profile') {
        const nameMatch = args.slice(2).join(' ').match(/name=(.+)/i);
        if (!nameMatch) return `Usage: netsh wlan delete profile name=<string> [interface=<string>]`;
        const name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
        return wlan.deleteProfile(name) ? `Profile "${name}" is deleted from interface Wi-Fi.` : `Profile "${name}" is not found in the system.`;
      }
      return NETSH_WLAN_HELP;
    }

    if (sub === 'connect') {
      if (!args.slice(1).join(' ').match(/name=(.+)/i)) return `Usage: netsh wlan connect name=<string> [interface=<string>]`;
      return `Connection request was completed successfully.`;
    }
    if (sub === 'disconnect') return `Disconnection request was completed successfully.`;
    if (sub === 'set') return `Ok.`;
    return `The subcommand "${args[0]}" was not found.\nType "netsh wlan ?" for more information.`;
  }

  // ─── netsh http ───────────────────────────────────────────────────
  private handleHttp(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') return NETSH_HTTP_HELP;
    const sub = args[0].toLowerCase();
    const http = nc.http;

    if (sub === 'add') {
      const obj = (args[1] || '').toLowerCase();
      if (obj === 'iplisten') {
        const ip = args[2] || '';
        if (!ip) return `Usage: netsh http add iplisten ipaddress=<string>`;
        if (!isValidIPv4(ip)) return `Invalid IP address: "${ip}".`;
        if (http.ipListen().includes(ip)) return `The IP address "${ip}" already exists in the IP listen list.`;
        http.addIpListen(ip);
        return `IP address successfully added`;
      }
      if (obj === 'sslcert') {
        const joined = args.slice(2).join(' ');
        const certhash = (joined.match(/certhash=(\S+)/i) || [])[1] || '';
        if (!certhash) return `Usage: netsh http add sslcert ipport=<ip>:<port> certhash=<hash> appid=<guid>`;
        http.addSslCert({
          ipport: (joined.match(/ipport=(\S+)/i) || [])[1] || '',
          certhash,
          appid: (joined.match(/appid=(\S+)/i) || [])[1] || '',
        });
        return `SSL Certificate successfully added`;
      }
      return NETSH_HTTP_HELP;
    }

    if (sub === 'show') {
      const obj = (args[1] || '').toLowerCase();
      if (obj === 'iplisten') {
        const lines = ['', 'IP addresses present in the IP listen list:', '-----------------------------------------'];
        if (http.ipListen().length === 0) lines.push('  (none)');
        for (const ip of http.ipListen()) lines.push(`    ${ip}`);
        lines.push('');
        return lines.join('\n');
      }
      if (obj === 'sslcert') {
        const lines = ['', 'SSL Certificate bindings:', '-----------------------------------------'];
        if (http.sslCerts().length === 0) lines.push('  (none)');
        for (const c of http.sslCerts()) {
          lines.push(`    IP:port                 : ${c.ipport}`);
          lines.push(`    Certificate Hash        : ${c.certhash}`);
          lines.push(`    Application ID          : ${c.appid}`, '');
        }
        return lines.join('\n');
      }
      return `Usage: netsh http show iplisten|sslcert|urlacl|servicestate|timeout|cacheparam`;
    }

    if (sub === 'delete') {
      if ((args[1] || '').toLowerCase() === 'iplisten') {
        const ip = args[2] || '';
        return http.removeIpListen(ip) ? `IP address successfully deleted` : `The IP address "${ip}" is not in the IP listen list.`;
      }
      return NETSH_HTTP_HELP;
    }

    return `The subcommand "${args[0]}" was not found.\nType "netsh http ?" for more information.`;
  }

  // ─── netsh bridge ─────────────────────────────────────────────────
  private handleBridge(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') return NETSH_BRIDGE_HELP;
    const sub = args[0].toLowerCase();
    const bridge = nc.bridge;

    if (sub === 'create') {
      const name = this.parseNameValue(args.slice(1))['name'] || args[1] || '';
      if (!name) return `Usage: netsh bridge create name=<string>`;
      return bridge.create(name) ? 'Ok.' : `The bridge "${name}" already exists.`;
    }
    if (sub === 'add') {
      const p = this.parseNameValue(args.slice(1));
      const bridgeName = p['name'] || args[1] || '';
      const adapter = p['adapter'] || args[2] || '';
      return bridge.addMember(bridgeName, adapter) ? 'Ok.' : `The bridge "${bridgeName}" was not found.`;
    }
    if (sub === 'show') {
      if ((args[1] || '').toLowerCase() === 'adapter') {
        const bridgeName = args[2] || '';
        const b = bridge.bridges().find((x) => x.name === bridgeName);
        if (!b) return `The bridge "${bridgeName}" was not found.`;
        const lines = ['', `Bridge: ${b.name}`, `Members:`];
        for (const m of b.members) lines.push(`  ${m}`);
        lines.push('');
        return lines.join('\n');
      }
      const lines = ['', 'Bridges:', '---'];
      for (const b of bridge.bridges()) lines.push(`  ${b.name} (${b.members.length} members)`);
      lines.push('');
      return lines.join('\n');
    }
    if (sub === 'delete') {
      const bridgeName = args[1] || this.parseNameValue(args.slice(1))['name'] || '';
      bridge.delete(bridgeName);
      return 'Ok.';
    }
    return `The subcommand "${args[0]}" was not found.\nType "netsh bridge ?" for more information.`;
  }

  // ─── netsh namespace (NRPT) ───────────────────────────────────────
  private handleNamespace(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') return NETSH_NAMESPACE_HELP;
    const sub = args[0].toLowerCase();

    if (sub === 'add') {
      if ((args[1] || '').toLowerCase() === 'policy') {
        const p = this.parseNameValue(args.slice(2));
        if (!p['namespace']) return `Usage: netsh namespace add policy name=<string> namespace=<string> [dnsservers=<ip>]`;
        nc.nrpt.add({ name: p['name'] || '', namespace: p['namespace'], dnsservers: p['dnsservers'] || '' });
        return 'Ok.';
      }
      return NETSH_NAMESPACE_HELP;
    }
    if (sub === 'show') {
      const obj = (args[1] || '').toLowerCase();
      if (obj === 'policy' || obj === '') {
        const lines = ['', 'NRPT Policies:', '---'];
        if (nc.nrpt.policies().length === 0) lines.push('  (none)');
        for (const p of nc.nrpt.policies()) {
          lines.push(`  Namespace: ${p.namespace}`);
          if (p.name) lines.push(`  Name:      ${p.name}`);
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

  // ─── netsh advfirewall ────────────────────────────────────────────
  private handleAdvfirewall(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') return NETSH_ADVFW_HELP;
    const sub = args[0].toLowerCase();
    if (sub === 'firewall') return this.handleAdvfwFirewall(nc, args.slice(1));
    if (sub === 'reset') { nc.firewall.clearRules(); return 'Ok.'; }
    if (sub === 'show') return 'Ok.';
    if (sub === 'set') return 'Ok.';
    return `The subcommand "${args[0]}" was not found.\nType "netsh advfirewall ?" for more information.`;
  }

  private handleAdvfwFirewall(nc: WindowsNetConfigApi, args: string[]): string {
    if (args.length === 0 || args[0] === '?' || args[0] === '/?' || args[0].toLowerCase() === 'help') return NETSH_ADVFW_FIREWALL_HELP;
    const sub = args[0].toLowerCase();
    const fw = nc.firewall;

    if (sub === 'add') {
      if ((args[1] || '').toLowerCase() === 'rule') {
        if (args.some((a) => a === '?')) return NETSH_ADVFW_FIREWALL_ADD_RULE_HELP;
        const p = this.parseNameValue(args.slice(2));
        const name = p['name'];
        if (!name) return NETSH_ADVFW_FIREWALL_ADD_RULE_HELP;
        if (fw.hasRule(name)) return `The rule "${name}" already exists.`;
        fw.addRule({
          name, displayName: name,
          enabled: (p['enable'] ?? 'yes').toLowerCase() !== 'no',
          action: normalizeAction(p['action'] ?? 'allow'),
          direction: normalizeDirection(p['dir'] ?? 'in'),
          protocol: normalizeProtocol(p['protocol'] ?? 'Any'),
          localPort: p['localport'] ?? '',
          remotePort: p['remoteport'] ?? '',
          description: '',
        });
        return 'Ok.';
      }
      return NETSH_ADVFW_FIREWALL_HELP;
    }

    if (sub === 'show') {
      if ((args[1] || '').toLowerCase() === 'rule') {
        const name = this.parseNameValue(args.slice(2))['name'];
        const matches = name ? fw.rules().filter((r) => r.name === name) : fw.rules();
        if (matches.length === 0) return `No rules match the specified criteria.`;
        const lines: string[] = [''];
        for (const r of matches) {
          lines.push(`Rule Name:                            ${r.name}`);
          lines.push(`----------------------------------------------------------------------`);
          lines.push(`Enabled:                              ${r.enabled ? 'Yes' : 'No'}`);
          lines.push(`Direction:                            ${r.direction.toLowerCase().startsWith('out') ? 'out' : 'in'}`);
          lines.push(`Profiles:                             Any`);
          lines.push(`Action:                               ${r.action}`);
          lines.push(`Protocol:                             ${r.protocol}`);
          lines.push(`LocalPort:                            ${r.localPort || 'Any'}`, '');
        }
        return lines.join('\n');
      }
      return NETSH_ADVFW_FIREWALL_HELP;
    }

    if (sub === 'delete') {
      if ((args[1] || '').toLowerCase() === 'rule') {
        const name = this.parseNameValue(args.slice(2))['name'];
        return fw.deleteRules(name) > 0 ? 'Ok.' : `No rules match the specified criteria.`;
      }
      return NETSH_ADVFW_FIREWALL_HELP;
    }

    return `The subcommand "${args[0]}" was not found.\nType "netsh advfirewall firewall ?" for more information.`;
  }

  // ─── netsh dhcp server ────────────────────────────────────────────
  private handleDhcpServer(nc: WindowsNetConfigApi, argv: string[]): string {
    const HELP = `Usage: netsh dhcp server add scope <ScopeAddress> <SubnetMask> <ScopeName>
       netsh dhcp server scope <ScopeAddress> add excluderange <StartIP> <EndIP>
       netsh dhcp server scope <ScopeAddress> add reservedip <ReservedIP> <ClientMACAddress> [Name]
       netsh dhcp server show scope`;
    const server = nc.dhcpServer;
    if (!server) return 'The DHCP Server service is not available on this computer.';
    let args = argv;
    if (args.length > 0 && args[0].toLowerCase() === 'server') args = args.slice(1);
    if (args.length === 0 || args[0] === '?' || args[0] === '/?') return HELP;
    const verb = args[0].toLowerCase();

    if (verb === 'add' && args[1]?.toLowerCase() === 'scope') {
      const [scopeAddress, subnetMask, ...nameParts] = args.slice(2);
      if (!scopeAddress || !subnetMask) return HELP;
      const scopeName = nameParts.join(' ') || scopeAddress;
      let network: IPAddress, mask: SubnetMask;
      try {
        mask = new SubnetMask(subnetMask);
        network = new IPAddress(scopeAddress).networkAddress(mask);
      } catch { return 'The scope parameters are incorrect.'; }
      const networkNum = network.toUint32();
      const broadcastNum = (networkNum | (~mask.toUint32() >>> 0)) >>> 0;
      const start = IPAddress.fromUint32(networkNum + 1).toString();
      const end = IPAddress.fromUint32(broadcastNum - 1).toString();
      const res = server.addScope(scopeName, start, end, subnetMask);
      return res.ok ? 'Command completed successfully.' : res.message;
    }

    if (verb === 'show' && args[1]?.toLowerCase() === 'scope') {
      const scopes = server.scopes();
      if (scopes.length === 0) return 'No scopes configured on this DHCP server.';
      return scopes.map((s) => `Scope Address - ${s.name}\tSubnetMask - ${s.subnetMask}\tState - Active`).join('\n');
    }

    if (verb === 'scope') {
      const scopeAddress = args[1];
      const scope = scopeAddress ? server.findScope(scopeAddress) : null;
      if (!scope) return `The scope parameters are incorrect.\nThe scope ${scopeAddress ?? ''} does not exist.`;
      const sub = args[2]?.toLowerCase();
      if (sub === 'add' && args[3]?.toLowerCase() === 'excluderange') {
        const startIp = args[4], endIp = args[5];
        if (!startIp || !endIp) return 'Usage: netsh dhcp server scope <ScopeAddress> add excluderange <StartIP> <EndIP>';
        const res = server.addExclusionRange(startIp, endIp);
        return res.ok ? 'Command completed successfully.' : res.message;
      }
      if (sub === 'add' && args[3]?.toLowerCase() === 'reservedip') {
        const reservedIp = args[4], clientMac = args[5];
        if (!reservedIp || !clientMac) return 'Usage: netsh dhcp server scope <ScopeAddress> add reservedip <ReservedIP> <ClientMACAddress> [Name]';
        const res = server.addReservation(scope.name, reservedIp, clientMac);
        return res.ok ? 'Command completed successfully.' : res.message;
      }
      return HELP;
    }

    return HELP;
  }

  // ─── netsh nps ────────────────────────────────────────────────────
  private handleNps(nc: WindowsNetConfigApi, args: string[]): string {
    const HELP = `Usage: netsh nps add client name="<Name>" address="<IPAddress>" secret="<SharedSecret>"
       netsh nps show clients`;
    const nps = nc.nps;
    if (!nps) return 'The Network Policy Server service is not available on this computer.';
    if (args.length === 0 || args[0] === '?' || args[0] === '/?') return HELP;
    const verb = args[0].toLowerCase();

    if (verb === 'add' && args[1]?.toLowerCase() === 'client') {
      const kv = this.parseQuotedKeyValue(args.slice(2));
      const name = kv.get('name'), address = kv.get('address'), secret = kv.get('secret');
      if (!name || !address || !secret) return HELP;
      const res = nps.addNasClient(name, address, secret);
      return res.ok ? 'Command completed successfully.' : res.message;
    }
    if (verb === 'show' && args[1]?.toLowerCase() === 'clients') {
      const clients = nps.nasClients();
      if (clients.length === 0) return 'No RADIUS clients configured on this NPS server.';
      return clients.map((c) => `Name - ${c.name}\tAddress - ${c.ipAddress}`).join('\n');
    }
    return HELP;
  }

  private parseQuotedKeyValue(args: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const a of args) {
      const m = /^([a-zA-Z]+)=(?:"([^"]*)"|(\S+))$/.exec(a);
      if (m) out.set(m[1].toLowerCase(), m[2] ?? m[3] ?? '');
    }
    return out;
  }
}
