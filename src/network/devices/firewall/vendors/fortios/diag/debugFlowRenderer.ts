import type { IPv4Packet } from '../../../../../core/types';
import type { PacketContext, PipelineTraceEntry } from '../../../pipeline/PacketContext';
import { portsOf } from '../../../diag/PacketCapture';

export interface DebugFlowFilter {
  addr?: string;
  saddr?: string;
  daddr?: string;
  port?: number;
  proto?: number;
}

export interface DebugFlowState {
  enabled: boolean;
  traceCount: number;
  showFunctionName: boolean;
  showConsole: boolean;
  filter: DebugFlowFilter;
  nextTraceId: number;
}

export const DEBUG_FLOW_ID = 'id=20085';

const FUNCTIONS: Readonly<Record<string, { name: string; line: number }>> = Object.freeze({
  received: { name: 'print_pkt_detail', line: 5590 },
  allocate: { name: 'init_ip_session_common', line: 5760 },
  route: { name: 'vf_ip_route_input_common', line: 2611 },
  allowed: { name: 'fw_forward_handler', line: 771 },
  denied: { name: 'fw_forward_handler', line: 749 },
  translate: { name: '__ip_session_run_tuple', line: 3546 },
  reverse: { name: 'ipd_post_route_handler', line: 490 },
  dropped: { name: 'fw_forward_dirty_handler', line: 401 },
  noroute: { name: 'vf_ip4_route_input_common', line: 2611 },
});

export function makeDebugFlowState(): DebugFlowState {
  return {
    enabled: false,
    traceCount: 0,
    showFunctionName: false,
    showConsole: true,
    filter: {},
    nextTraceId: 1,
  };
}

export function debugFlowAccepts(
  context: PacketContext, filter: DebugFlowFilter,
): boolean {
  const packet = context.originalPacket;
  if (packet.type !== 'ipv4') return false;

  const source = packet.sourceIP.toString();
  const destination = packet.destinationIP.toString();

  if (filter.addr !== undefined && source !== filter.addr && destination !== filter.addr) {
    return false;
  }
  if (filter.saddr !== undefined && source !== filter.saddr) return false;
  if (filter.daddr !== undefined && destination !== filter.daddr) return false;
  if (filter.proto !== undefined && packet.protocol !== filter.proto) return false;
  if (filter.port === undefined) return true;

  const ports = portsOf(packet);
  return ports.source === filter.port || ports.destination === filter.port;
}

export function renderDebugFlow(
  contexts: readonly PacketContext[], state: DebugFlowState, vdom: string,
): string {
  const lines: string[] = [];
  let traceId = state.nextTraceId;

  for (const context of contexts) {
    if (state.traceCount > 0 && traceId - state.nextTraceId >= state.traceCount) break;
    if (!debugFlowAccepts(context, state.filter)) continue;

    lines.push(...renderOne(context, traceId, state.showFunctionName, vdom));
    traceId++;
  }
  return lines.join('\n');
}

function renderOne(
  context: PacketContext, traceId: number, showFunction: boolean, vdom: string,
): string[] {
  const packet = context.originalPacket as IPv4Packet;
  const ports = portsOf(packet);
  const out: string[] = [];

  const say = (key: keyof typeof FUNCTIONS, message: string): void => {
    const meta = FUNCTIONS[key];
    const prefix = showFunction
      ? `${DEBUG_FLOW_ID} trace_id=${traceId} func=${meta.name} line=${meta.line}`
      : `${DEBUG_FLOW_ID} trace_id=${traceId}`;
    out.push(`${prefix} msg="${message}"`);
  };

  const endpoints = packet.protocol === 6 || packet.protocol === 17
    ? `${packet.sourceIP}:${ports.source}->${packet.destinationIP}:${ports.destination}`
    : `${packet.sourceIP}->${packet.destinationIP}`;

  say('received', `vd-${vdom}:0 received a packet(proto=${packet.protocol},`
    + ` ${endpoints}) tun_id=0.0.0.0 from ${context.ingressPort}.`);

  if (context.session !== undefined) {
    say('allocate', `allocate a new session-${context.session.id.toString(16).padStart(8, '0')}`);
  }

  const routed = findTrace(context.trace, 'route-lookup') ?? findTrace(context.trace, 'policy-route');
  if (context.egressPort !== undefined && routed) {
    say('route', `find a route: flag=04000000 gw-${packet.destinationIP} via ${context.egressPort}`);
  }

  if (context.verdict?.action !== 'accept' && context.verdict !== undefined) {
    out.push(...renderDenial(context, say));
    return out;
  }

  say('allowed', `Allowed by Policy-${context.matchedPolicy?.id ?? 0}:`
    + `${context.destinationTranslated ? ' DNAT' : ''}`
    + `${translatedSource(context) ? ' SNAT' : ''}`
    || `Allowed by Policy-${context.matchedPolicy?.id ?? 0}:`);

  const snat = translatedSource(context);
  if (snat) say('translate', `SNAT ${packet.sourceIP}->${snat}`);

  if (context.destinationTranslated) {
    const current = context.packet as IPv4Packet;
    say('reverse', `DNAT ${packet.destinationIP}->${current.destinationIP}`);
  }
  return out;
}

function renderDenial(
  context: PacketContext,
  say: (key: 'denied' | 'dropped' | 'noroute', message: string) => void,
): string[] {
  const reason = context.verdict?.reason;

  if (reason === 'no-route') {
    say('noroute', 'no route to destination');
    return [];
  }
  if (reason === 'no-session-non-syn') {
    say('dropped', 'no session matched, drop');
    return [];
  }

  if (reason === 'policy-deny' || reason === 'implicit-deny') {
    say('denied', 'Denied by forward policy check (policy '
      + `${reason === 'implicit-deny' ? '0' : context.matchedPolicy?.id ?? 0})`);
    return [];
  }
  say('dropped', `reverse path check fail, drop (${reason ?? 'unknown'})`);
  return [];
}

function translatedSource(context: PacketContext): string | undefined {
  const original = context.originalPacket;
  const current = context.packet;
  if (original.type !== 'ipv4' || current.type !== 'ipv4') return undefined;

  const before = original.sourceIP.toString();
  const after = current.sourceIP.toString();
  return before === after ? undefined : after;
}

function findTrace(
  trace: readonly PipelineTraceEntry[], stage: string,
): PipelineTraceEntry | undefined {
  return trace.find(entry => entry.stage === stage && entry.verdict === 'continue');
}
