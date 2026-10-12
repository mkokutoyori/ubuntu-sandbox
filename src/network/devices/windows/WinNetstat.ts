import type { SocketEntry } from '../../core/SocketTable';
import { IPAddress, IPv6Address } from '../../core/types';
import { IanaServiceRegistry } from '../../core/ports/IanaServiceRegistry';
import { renderTable, type TableColumn, type TableStyle } from '../shells/cli/TextTable';
import type { NetstatProtocolFilter } from './WinNetstatStatistics';
import { HOST_OFFLOAD_STATE, appliedSettingOf, netTcpStateOf } from './netTcpConnection';

export interface NetstatLinkCounters {
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly framesIn: number;
  readonly framesOut: number;
}

export interface NetstatMachine {
  readonly computerName: string;
  readonly primaryDnsSuffix: string;
  readonly elevated: boolean;
  sockets(): readonly SocketEntry[];
  processImage(pid: number): string | null;
  servicesFile(): string | null;
  isOwnAddress(address: string): boolean;
  zoneOf(address: string): number | null;
  resolveAddress(address: string): Promise<string | null>;
  linkCounters(): NetstatLinkCounters;
  routePrint(): string;
  protocolStatistics(only: NetstatProtocolFilter | null): string;
}

type NetstatFamily = 'ip' | 'ipv6' | 'icmp' | 'icmpv6' | 'tcp' | 'tcpv6' | 'udp' | 'udpv6';

type NetstatTransport = 'tcp' | 'tcpv6' | 'udp' | 'udpv6';

export interface NetstatOptions {
  readonly all: boolean;
  readonly executable: boolean;
  readonly ethernet: boolean;
  readonly fqdn: boolean;
  readonly numeric: boolean;
  readonly owner: boolean;
  readonly bound: boolean;
  readonly routes: boolean;
  readonly statistics: boolean;
  readonly offload: boolean;
  readonly networkDirect: boolean;
  readonly template: boolean;
  readonly protocols: readonly NetstatFamily[];
}

const ELEVATION_REQUIRED = 'The requested operation requires elevation.';

const NETWORK_DIRECT_REPORT = [
  '',
  'Active NetworkDirect Connections, Listeners, SharedEndpoints',
  '',
  '  Mode   IfIndex Type Local Address               Foreign Address             PID',
].join('\n');

const SYSTEM_PID = 4;

const SHARED_SERVICE_HOST = 'svchost.exe';

const FAMILIES: ReadonlySet<string> = new Set(['ip', 'ipv6', 'icmp', 'icmpv6', 'tcp', 'tcpv6', 'udp', 'udpv6']);

const TRANSPORTS: ReadonlySet<string> = new Set(['tcp', 'tcpv6', 'udp', 'udpv6']);

const SWITCHES = 'abefnoqrstxy';

const TEMPLATE_COMPANIONS: ReadonlySet<string> = new Set(['y', 'a', 'f', 'p']);

export const NETSTAT_USAGE = [
  '',
  'Displays protocol statistics and current TCP/IP network connections.',
  '',
  'NETSTAT [-a] [-b] [-e] [-f] [-n] [-o] [-p proto] [-r] [-s] [-t] [-x] [-y] [interval]',
  '',
  '  -a            Displays all connections and listening ports.',
  '  -b            Displays the executable involved in creating each connection or',
  '                listening port. In some cases well-known executables host',
  '                multiple independent components, and in these cases the',
  '                sequence of components involved in creating the connection',
  '                or listening port is displayed. In this case the executable',
  '                name is in [] at the bottom, on top is the component it called,',
  '                and so forth until TCP/IP was reached. Note that this option',
  '                can be time-consuming and will fail unless you have sufficient',
  '                permissions.',
  '  -e            Displays Ethernet statistics. This may be combined with the -s',
  '                option.',
  '  -f            Displays Fully Qualified Domain Names (FQDN) for foreign',
  '                addresses.',
  '  -n            Displays addresses and port numbers in numerical form.',
  '  -o            Displays the owning process ID associated with each connection.',
  '  -p proto      Shows connections for the protocol specified by proto; proto',
  '                may be any of: TCP, UDP, TCPv6, or UDPv6.  If used with the -s',
  '                option to display per-protocol statistics, proto may be any of:',
  '                IP, IPv6, ICMP, ICMPv6, TCP, TCPv6, UDP, or UDPv6.',
  '  -q            Displays all connections, listening ports, and bound',
  '                nonlistening TCP ports. Bound nonlistening ports may or may not',
  '                be associated with an active connection.',
  '  -r            Displays the routing table.',
  '  -s            Displays per-protocol statistics.  By default, statistics are',
  '                shown for IP, IPv6, ICMP, ICMPv6, TCP, TCPv6, UDP, and UDPv6;',
  '                the -p option may be used to specify a subset of the default.',
  '  -t            Displays the current connection offload state.',
  '  -x            Displays NetworkDirect connections, listeners, and shared',
  '                endpoints.',
  '  -y            Displays the TCP connection template for all connections.',
  '                Cannot be combined with the other options.',
  '  interval      Redisplays selected statistics, pausing interval seconds',
  '                between each display.  Press CTRL+C to stop redisplaying',
  '                statistics.  If omitted, netstat will print the current',
  '                configuration information once.',
].join('\n');

export function parseNetstatArguments(args: readonly string[]): NetstatOptions | null {
  const switches = new Set<string>();
  const protocols: NetstatFamily[] = [];
  let position = 0;
  while (position < args.length) {
    const token = args[position++];
    if (/^[-/]/.test(token)) {
      for (const letter of token.slice(1).toLowerCase()) {
        if (letter === 'p') {
          switches.add('p');
          const before = protocols.length;
          while (position < args.length && FAMILIES.has(args[position].toLowerCase())) {
            protocols.push(args[position++].toLowerCase() as NetstatFamily);
          }
          if (protocols.length === before) return null;
        } else if (SWITCHES.includes(letter)) {
          switches.add(letter);
        } else {
          return null;
        }
      }
    } else if (!/^\d+$/.test(token)) {
      return null;
    }
  }
  const statistics = switches.has('s');
  if (!statistics && protocols.some((family) => !TRANSPORTS.has(family))) return null;
  if (switches.has('y') && [...switches].some((letter) => !TEMPLATE_COMPANIONS.has(letter))) return null;
  return {
    all: switches.has('a'),
    executable: switches.has('b'),
    ethernet: switches.has('e'),
    fqdn: switches.has('f'),
    numeric: switches.has('n'),
    owner: switches.has('o'),
    bound: switches.has('q'),
    routes: switches.has('r'),
    statistics,
    offload: switches.has('t'),
    networkDirect: switches.has('x'),
    template: switches.has('y'),
    protocols,
  };
}

type RowTransport = 'TCP' | 'UDP';

interface NetstatRow {
  readonly entry: SocketEntry;
  readonly transport: RowTransport;
  readonly family: 4 | 6;
  readonly state: string;
}

const STATE_LABELS: Readonly<Record<string, string>> = { LISTEN: 'LISTENING' };

const ROW_STYLE: TableStyle = { gap: 1, rule: false, indent: '  ' };

const GROUP_ORDER: Readonly<Record<string, number>> = { 'TCP4': 0, 'TCP6': 1, 'UDP4': 2, 'UDP6': 3 };

function familyOf(address: string): 4 | 6 {
  return address.includes(':') ? 6 : 4;
}

function transportKey(row: NetstatRow): NetstatTransport {
  const base = row.transport === 'TCP' ? 'tcp' : 'udp';
  return row.family === 6 ? `${base}v6` : base;
}

function rowsOf(machine: NetstatMachine): NetstatRow[] {
  const rows: NetstatRow[] = [];
  for (const entry of machine.sockets()) {
    if (entry.protocol === 'udplite') continue;
    rows.push({
      entry,
      transport: entry.protocol === 'tcp' ? 'TCP' : 'UDP',
      family: familyOf(entry.localAddress),
      state: entry.protocol === 'tcp' ? STATE_LABELS[entry.state] ?? entry.state : '',
    });
  }
  return rows;
}

function addressOrder(address: string): number[] {
  const bare = address.replace(/%.*$/, '');
  if (bare.includes(':')) return IPv6Address.tryParse(bare)?.getHextets() ?? [];
  const parsed = IPAddress.tryParse(bare);
  return parsed === null ? [] : [parsed.toUint32()];
}

function compareOrders(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

function compareRows(left: NetstatRow, right: NetstatRow): number {
  const group = GROUP_ORDER[`${left.transport}${left.family}`] - GROUP_ORDER[`${right.transport}${right.family}`];
  if (group !== 0) return group;
  return compareOrders(addressOrder(left.entry.localAddress), addressOrder(right.entry.localAddress))
    || left.entry.localPort - right.entry.localPort
    || compareOrders(addressOrder(left.entry.remoteAddress), addressOrder(right.entry.remoteAddress))
    || left.entry.remotePort - right.entry.remotePort;
}

function isListener(row: NetstatRow): boolean {
  return row.transport === 'UDP' || row.entry.state === 'LISTEN';
}

function selected(row: NetstatRow, options: NetstatOptions): boolean {
  if (options.protocols.length > 0 && !options.protocols.includes(transportKey(row))) return false;
  if (row.entry.state === 'BOUND') return options.bound;
  return options.all || options.bound || !isListener(row);
}

function wildcard(family: 4 | 6): string {
  return family === 6 ? '::' : '0.0.0.0';
}

function endpointText(address: string, port: number | string, family: 4 | 6, zone: number | null): string {
  if (family === 4) return `${address}:${port}`;
  const bare = address.replace(/%.*$/, '');
  const scope = address.includes('%') ? address.slice(address.indexOf('%')) : zone === null ? '' : `%${zone}`;
  return `[${bare}${scope}]:${port}`;
}

function firstLabel(name: string): string {
  const trimmed = name.replace(/\.$/, '');
  const dot = trimmed.indexOf('.');
  return dot === -1 ? trimmed : trimmed.slice(0, dot);
}

class ForeignNames {
  private readonly resolved = new Map<string, string | null>();
  private readonly services: IanaServiceRegistry;

  constructor(private readonly machine: NetstatMachine, private readonly options: NetstatOptions) {
    const file = machine.servicesFile();
    this.services = file === null ? new IanaServiceRegistry() : IanaServiceRegistry.fromServicesFile(file);
  }

  async cell(row: NetstatRow): Promise<string> {
    if (row.transport === 'UDP') return '*:*';
    const unconnected = row.entry.state === 'LISTEN' || row.entry.remoteAddress === '*';
    const address = unconnected ? wildcard(row.family) : row.entry.remoteAddress;
    const port = unconnected ? 0 : row.entry.remotePort;
    if (this.options.numeric) return endpointText(address, port, row.family, null);
    const host = await this.host(address, row.family);
    return `${host}:${this.services.lookup(port, 'tcp')?.name ?? port}`;
  }

  private async host(address: string, family: 4 | 6): Promise<string> {
    if (this.machine.isOwnAddress(address)) return this.localName();
    if (!this.resolved.has(address)) this.resolved.set(address, await this.machine.resolveAddress(address));
    const name = this.resolved.get(address);
    if (name === null || name === undefined) return family === 6 ? `[${address}]` : address;
    return this.options.fqdn ? name.replace(/\.$/, '') : firstLabel(name);
  }

  private localName(): string {
    const suffix = this.machine.primaryDnsSuffix;
    return this.options.fqdn && suffix !== '' ? `${this.machine.computerName}.${suffix}` : this.machine.computerName;
  }
}

function interfaceStatistics(counters: NetstatLinkCounters): string {
  const row = (label: string, received: number, sent: number | null) =>
    `${label.padEnd(24)}${String(received).padStart(12)}${sent === null ? '' : String(sent).padStart(16)}`;
  return [
    '',
    'Interface Statistics',
    '',
    `${''.padEnd(24)}${'Received'.padStart(12)}${'Sent'.padStart(16)}`,
    '',
    row('Bytes', counters.bytesIn, counters.bytesOut),
    row('Unicast packets', counters.framesIn, counters.framesOut),
    row('Non-unicast packets', 0, 0),
    row('Discards', 0, 0),
    row('Errors', 0, 0),
    row('Unknown protocols', 0, null),
    '',
  ].join('\n');
}

const STATISTICS_FILTERS: ReadonlyArray<readonly [NetstatFamily, NetstatProtocolFilter]> = [
  ['ip', 'ip'], ['icmp', 'icmp'], ['tcp', 'tcp'], ['udp', 'udp'],
];

function protocolStatistics(machine: NetstatMachine, options: NetstatOptions): string {
  if (options.protocols.length === 0) return machine.protocolStatistics(null);
  const wanted = STATISTICS_FILTERS.filter(([family]) => options.protocols.includes(family));
  return wanted.map(([, filter]) => machine.protocolStatistics(filter)).join('\n');
}

function statistics(machine: NetstatMachine, options: NetstatOptions): string {
  if (!options.statistics) return interfaceStatistics(machine.linkCounters());
  const protocols = protocolStatistics(machine, options);
  return options.ethernet ? `${interfaceStatistics(machine.linkCounters()).trimEnd()}\n${protocols}` : protocols;
}

function componentLines(machine: NetstatMachine, row: NetstatRow): string[] {
  const pid = row.entry.pid ?? 0;
  const image = pid === 0 || pid === SYSTEM_PID ? null : machine.processImage(pid);
  if (image === null) return [' Can not obtain ownership information'];
  const service = row.entry.serviceName;
  const hosted = image.toLowerCase() === SHARED_SERVICE_HOST && service !== undefined;
  return hosted ? [`  ${service}`, ` [${image}]`] : [` [${image}]`];
}

async function listing(machine: NetstatMachine, options: NetstatOptions): Promise<string> {
  if (options.executable && !machine.elevated) return ELEVATION_REQUIRED;
  const rows = rowsOf(machine)
    .filter((row) => selected(row, options) && (!options.template || row.transport === 'TCP'))
    .sort(compareRows);
  const names = new ForeignNames(machine, options);
  const foreign = new Map<NetstatRow, string>();
  for (const row of rows) foreign.set(row, await names.cell(row));
  const columns: Array<TableColumn<NetstatRow>> = [
    { header: 'Proto', width: 6, value: (row) => row.transport },
    {
      header: 'Local Address', width: 22,
      value: (row) => endpointText(row.entry.localAddress, row.entry.localPort, row.family, machine.zoneOf(row.entry.localAddress)),
    },
    { header: 'Foreign Address', width: 22, value: (row) => foreign.get(row) ?? '' },
    { header: 'State', width: 15, value: (row) => row.state },
  ];
  if (options.owner) columns.push({ header: 'PID', value: (row) => String(row.entry.pid ?? 0) });
  if (options.offload) {
    columns.push({ header: 'Offload State', value: (row) => (row.transport === 'TCP' ? HOST_OFFLOAD_STATE : '') });
  }
  if (options.template) {
    columns.push({ header: 'Template', value: (row) => appliedSettingOf(netTcpStateOf(row.entry.state)) });
  }
  const [header, ...lines] = renderTable(rows, columns, ROW_STYLE);
  const body = options.executable ? lines.flatMap((line, index) => [line, ...componentLines(machine, rows[index])]) : lines;
  const spacer = options.offload || options.template ? [''] : [];
  return ['', 'Active Connections', '', header, ...spacer, ...body].join('\n');
}

export async function runNetstat(machine: NetstatMachine, args: readonly string[]): Promise<string> {
  const options = parseNetstatArguments(args);
  if (options === null) return NETSTAT_USAGE;
  if (options.routes) return machine.routePrint();
  if (options.networkDirect) return NETWORK_DIRECT_REPORT;
  if (options.ethernet || options.statistics) return statistics(machine, options);
  return listing(machine, options);
}
