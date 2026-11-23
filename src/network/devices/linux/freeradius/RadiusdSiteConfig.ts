import { IPAddress } from '@/network/core/types';
import type { RadiusClientEntry } from '@/network/radius/ClientTable';
import type { RadSecTls } from '@/network/radius/RadSecTlsPolicy';
import { readTlsBody } from './RadSecTlsSection';
import { UDP_PORT_RADIUS_ACCT, UDP_PORT_RADIUS_AUTH } from '@/network/radius/types';
import { readClientSections, type ParsedClients } from './ClientsConfParser';
import type { ConfSection } from './FreeradiusConf';

export type ListenerType = 'auth' | 'acct' | 'auth+acct' | 'status';

export type { RadSecTls };

export interface ListenerSpec {
  readonly type: ListenerType;
  readonly address: string | null;
  readonly port: number;
  readonly server: string;
  readonly file: string;
  readonly line: number;
  readonly tls?: RadSecTls;
}

export interface ControlSocket {
  readonly path: string;
  readonly writable: boolean;
}

export interface SiteConfig {
  readonly listeners: ListenerSpec[];
  readonly serverClients: ReadonlyMap<string, RadiusClientEntry[]>;
  readonly controlSockets: readonly ControlSocket[];
}

const SUPPORTED_TYPES = new Set<string>(['auth', 'acct', 'auth+acct', 'status']);
const KNOWN_UNMODELLED_TYPES = new Set(['auth+coa', 'auth+acct+coa', 'detail', 'proxy', 'vmps', 'dhcp', 'coa']);
const DEFAULT_PORT: Record<ListenerType, number> = { auth: UDP_PORT_RADIUS_AUTH, acct: UDP_PORT_RADIUS_ACCT, 'auth+acct': UDP_PORT_RADIUS_AUTH, status: UDP_PORT_RADIUS_AUTH };

export function defaultListeners(): ListenerSpec[] {
  const make = (type: ListenerType): ListenerSpec => ({ type, address: null, port: DEFAULT_PORT[type], server: 'default', file: '', line: 0 });
  return [make('auth'), make('acct')];
}

function pairValue(section: ConfSection, name: string): string | undefined {
  return section.pairs.find((candidate) => candidate.name === name)?.value;
}

export const RADSEC_DEFAULT_PORT = 2083;

function readTlsSection(listen: ConfSection): RadSecTls | undefined | { error: string } {
  const section = listen.sections.find((candidate) => candidate.name1 === 'tls');
  if (section === undefined) return undefined;
  if (pairValue(listen, 'proto') !== 'tcp') return { error: `${section.file}[${section.line}]: A tls section needs proto = tcp in the listen section` };
  return readTlsBody(section);
}

const CONTROL_KEYS = new Set(['type', 'socket', 'mode']);

const CONTROL_MODES: Readonly<Record<string, boolean>> = { ro: false, 'read-only': false, rw: true, 'read-write': true };

function readControlSocket(section: ConfSection): ControlSocket | { error: string } {
  const where = `${section.file}[${section.line}]`;
  for (const pair of section.pairs) {
    if (!CONTROL_KEYS.has(pair.name)) return { error: `${pair.file}[${pair.line}]: The control listener setting "${pair.name}" is not implemented in this simulator` };
  }
  const mode = pairValue(section, 'mode');
  if (mode !== undefined && CONTROL_MODES[mode] === undefined) return { error: `${where}: Invalid mode name '${mode}'` };
  const path = pairValue(section, 'socket');
  if (path === undefined || path === '') return { error: `${where}: No "socket" given in control listener` };
  return { path, writable: mode !== undefined && CONTROL_MODES[mode] };
}

export function readSiteConfig(root: ConfSection): SiteConfig | { error: string } {
  const servers = root.sections.filter((section) => section.name1 === 'server');
  const controlSockets: ControlSocket[] = [];
  for (const section of root.sections.filter((candidate) => candidate.name1 === 'listen' && pairValue(candidate, 'type') === 'control')) {
    const path = readControlSocket(section);
    if ('error' in path) return path;
    controlSockets.push(path);
  }
  if (servers.length === 0) return { listeners: defaultListeners(), serverClients: new Map(), controlSockets };
  const listeners: ListenerSpec[] = [];
  const serverClients = new Map<string, RadiusClientEntry[]>();
  for (const server of servers) {
    const serverName = server.name2 ?? '';
    for (const section of server.sections) {
      if (section.name1 !== 'listen') continue;
      const where = `${section.file}[${section.line}]`;
      const type = pairValue(section, 'type');
      if (type === 'control') {
        const path = readControlSocket(section);
        if ('error' in path) return path;
        controlSockets.push(path);
        continue;
      }
      if (type === undefined) return { error: `${where}: No type specified in listen section` };
      if (!SUPPORTED_TYPES.has(type)) {
        return {
          error: KNOWN_UNMODELLED_TYPES.has(type)
            ? `${where}: The listen type "${type}" is not implemented in this simulator`
            : `${where}: Invalid type "${type}" in listen section.`,
        };
      }
      const tlsRead = readTlsSection(section);
      if (tlsRead !== undefined && 'error' in tlsRead) return tlsRead;
      const tls = tlsRead as RadSecTls | undefined;
      const portText = pairValue(section, 'port');
      const port = portText === undefined ? 0 : Number(portText);
      if (!Number.isInteger(port) || port < 0 || port > 65535) return { error: `${where}: Invalid value "${portText}" for variable port` };
      if (pairValue(section, 'ipv6addr') !== undefined) return { error: `${where}: The listen setting "ipv6addr" is not implemented in this simulator: the RADIUS agents handle IPv4 only` };
      const addressText = pairValue(section, 'ipaddr') ?? pairValue(section, 'ipv4addr') ?? '*';
      let address: string | null = null;
      if (addressText !== '*') {
        const parsed = IPAddress.tryParse(addressText);
        if (parsed === null) return { error: `${where}: Failed finding address for ${addressText}` };
        address = parsed.toString();
      }
      listeners.push({
        type: type as ListenerType, address, port: port === 0 ? (tls === undefined ? DEFAULT_PORT[type as ListenerType] : RADSEC_DEFAULT_PORT) : port,
        server: pairValue(section, 'virtual_server') ?? serverName, file: section.file, line: section.line,
        ...(tls === undefined ? {} : { tls }),
      });
    }
    const own: ParsedClients = { clients: [], errors: [], warnings: [] };
    readClientSections(server.sections, own);
    if (own.errors.length > 0) return { error: own.errors[0] };
    if (own.clients.length > 0) serverClients.set(serverName, own.clients);
  }
  return { listeners: listeners.length === 0 ? defaultListeners() : listeners, serverClients, controlSockets };
}

export function listenerAddressText(spec: ListenerSpec): string {
  return spec.address ?? '*';
}

export function describeListener(spec: ListenerSpec): string {
  return `${spec.type} address ${listenerAddressText(spec)} port ${spec.port} bound to server ${spec.server}`;
}
