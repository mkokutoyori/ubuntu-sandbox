import type { FirewallSession } from '../../../session/SessionTable';
import type { SessionFamily } from '../../../session/SessionFamily';
import type { InterfaceTable } from '../../../l3/InterfaceTable';
import type { RouteTable } from '../../../l3/RouteTable';

export interface SessionFilter {
  src?: string;
  dst?: string;
  sport?: number;
  dport?: number;
  proto?: number;
  policy?: string;
  vd?: number;
}

export interface SessionRenderDeps {
  readonly now: () => number;
  readonly interfaces: InterfaceTable;
  readonly routes: RouteTable;
  readonly vdom: number;
  readonly family?: SessionFamily;
  readonly nextHop6?: (destination: string) => { iface: string; nextHop: string } | null;
  readonly interfaceIp6?: (iface: string) => string | null;
}

const UNSPECIFIED = Object.freeze({ ipv4: '0.0.0.0', ipv6: '::' });

const TCP_PROTO_STATE: Readonly<Record<string, string>> = Object.freeze({
  'syn-sent': '02',
  'syn-received': '03',
  established: '01',
  'fin-wait': '04',
  'close-wait': '05',
  'last-ack': '06',
  'time-wait': '07',
  closed: '00',
});

export interface OriginalFlow {
  readonly sourceIP: string;
  readonly sourcePort: number;
  readonly destIP: string;
  readonly destPort: number;
  readonly protocol: number;
}

export function originalFlow(session: FirewallSession): OriginalFlow {
  const flow = session.c2s;
  const translation = session.translation;
  if (translation === undefined) return flow;

  return {
    sourceIP: translation.originalSource,
    sourcePort: translation.originalSourcePort,
    destIP: translation.originalDest,
    destPort: translation.originalDestPort,
    protocol: flow.protocol,
  };
}

export function sessionMatchesFilter(
  session: FirewallSession, filter: SessionFilter,
): boolean {
  const flow = originalFlow(session);
  if (filter.src !== undefined && flow.sourceIP !== filter.src) return false;
  if (filter.dst !== undefined && flow.destIP !== filter.dst) return false;
  if (filter.sport !== undefined && flow.sourcePort !== filter.sport) return false;
  if (filter.dport !== undefined && flow.destPort !== filter.dport) return false;
  if (filter.proto !== undefined && flow.protocol !== filter.proto) return false;
  if (filter.policy !== undefined && session.policyId !== filter.policy) return false;
  return true;
}

export function filterIsEmpty(filter: SessionFilter): boolean {
  return Object.values(filter).every(value => value === undefined);
}

export function clearFilter(filter: SessionFilter): void {
  for (const name of Object.keys(filter)) {
    delete filter[name as keyof SessionFilter];
  }
}

export function renderSessionList(
  sessions: readonly FirewallSession[], deps: SessionRenderDeps,
): string {
  const lines: string[] = [];
  for (const session of sessions) lines.push(...renderSession(session, deps));
  lines.push(`total session ${sessions.length}`);
  return lines.join('\n');
}

function familyOf(deps: SessionRenderDeps): SessionFamily {
  return deps.family ?? 'ipv4';
}

function renderSession(session: FirewallSession, deps: SessionRenderDeps): string[] {
  const flow = originalFlow(session);
  const duration = Math.max(0, Math.floor((deps.now() - session.createdAt) / 1000));
  const expire = Math.max(0, Math.floor((session.expiresAt - deps.now()) / 1000));
  const counters = session.counters;

  const ingress = ifIndex(deps.interfaces, session.ingressInterface);
  const egress = ifIndex(deps.interfaces, session.egressInterface);

  const family = familyOf(deps);

  return [
    `${family === 'ipv6' ? 'session6' : 'session'} info:`
    + ` proto=${flow.protocol} proto_state=${protoState(session)}`
    + ` duration=${duration} expire=${expire} timeout=${session.timeoutSec}`,
    'flags=00000000 sockflag=00000000 sockport=0 av_idx=0 use=3',
    'origin-shaper=',
    'reply-shaper=',
    'per_ip_shaper=',
    `class_id=0 ha_id=0 policy_dir=0 tunnel=/ vlan_cos=0/255`,
    `state=${session.state === 'discard' ? 'log' : 'may_dirty'}`,
    'statistic(bytes/packets/allow_err):'
    + ` org=${counters.bytesC2S}/${counters.packetsC2S}/1`
    + ` reply=${counters.bytesS2C}/${counters.packetsS2C}/1 tuples=2`,
    'tx speed(Bps/kbps): 0/0 rx speed(Bps/kbps): 0/0',
    `orgin->sink: org pre->post, reply pre->post dev=${ingress}->${egress}/${egress}->${ingress}`,
    `gwy=${gateway(deps, session.egressInterface, flow.destIP)}/`
    + `${gateway(deps, session.ingressInterface, flow.sourceIP)}`,
    ...hooks(session, family),
    `misc=0 policy_id=${session.policyId ?? 0} auth_info=0 chk_client_info=0 vd=${deps.vdom}`,
    `serial=${serial(session.id)} tos=ff/ff app_list=0 app=0 url_cat=0`,
  ];
}

function hooks(session: FirewallSession, family: SessionFamily): string[] {
  const flow = originalFlow(session);
  const translation = session.translation;
  const original = `${flow.sourceIP}:${flow.sourcePort}->${flow.destIP}:${flow.destPort}`;
  const none = `(${UNSPECIFIED[family]}:0)`;

  if (!translation) {
    return [
      `hook=post dir=org act=noop ${original}${none}`,
      `hook=pre dir=reply act=noop ${flow.destIP}:${flow.destPort}`
      + `->${flow.sourceIP}:${flow.sourcePort}${none}`,
    ];
  }

  const snat = translation.translatedSource !== translation.originalSource;
  const dnat = translation.translatedDest !== translation.originalDest
    || translation.translatedDestPort !== translation.originalDestPort;

  const forward = `hook=${snat ? 'post' : 'pre'} dir=org act=${snat ? 'snat' : 'dnat'}`
    + ` ${translation.originalSource}:${translation.originalSourcePort}`
    + `->${translation.originalDest}:${translation.originalDestPort}`
    + `(${snat ? translation.translatedSource : translation.translatedDest}`
    + `:${snat ? translation.translatedSourcePort : translation.translatedDestPort})`;

  const reverse = `hook=${dnat ? 'post' : 'pre'} dir=reply act=${dnat ? 'dnat' : 'snat'}`
    + ` ${translation.translatedDest}:${translation.translatedDestPort}`
    + `->${translation.translatedSource}:${translation.translatedSourcePort}`
    + `(${translation.originalSource}:${translation.originalSourcePort})`;

  return [forward, reverse];
}

function protoState(session: FirewallSession): string {
  if (session.tcpState === undefined) return '00';
  return TCP_PROTO_STATE[session.tcpState] ?? '00';
}

function ifIndex(interfaces: InterfaceTable, name: string): number {
  const index = interfaces.names().indexOf(name);
  return index < 0 ? 0 : index + 3;
}

function gateway(deps: SessionRenderDeps, iface: string, destination: string): string {
  const family = familyOf(deps);
  const resolved = family === 'ipv6'
    ? deps.nextHop6?.(destination) ?? null : deps.routes.resolveNextHop(destination);
  if (resolved?.iface === iface) return resolved.nextHop;

  const own = family === 'ipv6'
    ? deps.interfaceIp6?.(iface) ?? null : deps.interfaces.get(iface)?.ip ?? null;
  return own ?? UNSPECIFIED[family];
}

function serial(id: number): string {
  return id.toString(16).padStart(8, '0');
}
