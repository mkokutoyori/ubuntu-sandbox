import { conserveModeLines, procMeminfoLines } from './systemLoad';
import { renderArpKernelList } from './getViews';
import { IPv6Address, type IPv4Packet } from '../../../../../core/types';
import type { FirewallSession } from '../../../session/SessionTable';
import type { Firewall } from '../../../Firewall';
import type { FirewallLogDraft } from '../../../logging/FirewallLogStore';
import type { PacketContext } from '../../../pipeline/PacketContext';
import {
  parseCaptureFilter, portsOf, type CaptureFilter,
} from '../../../diag/PacketCapture';
import { FortiMessages } from '../FortiMessages';
import { parseAuthFilter, renderAuthList } from './authListRenderer';
import { renderIkeGatewayList, renderVpnTunnelList } from './vpnTunnelRenderer';
import { unquote } from '../runtime/FortiNavigator';
import { referencesTo, renderReference } from '../runtime/references';
import { renderIpv6AddressList, renderIpv6NeighborCache } from './ipv6Renderers';
import type { FortiConfigTree } from '../runtime/FortiConfigTree';
import { formatLogRecord, type FortiLogContext, type FortiLogFormat } from '../log/fortiLogFormat';
import { type LoggedIdentity, trafficDenyLog } from '../log/trafficLog';
import type { FortiDiagnostics } from './FortiDiagnostics';
import { renderDebugFlow } from './debugFlowRenderer';
import { renderIpropeList, renderIpropeShow } from './ipropeRenderer';
import { renderSniffer } from './snifferRenderer';
import {
  clearFilter, filterIsEmpty, renderSessionList, sessionMatchesFilter,
  type SessionFilter,
} from './sessionListRenderer';
import {
  sessionFamily, type SessionFamily,
} from '../../../session/SessionFamily';

export interface FortiDiagDeps {
  readonly fw: Firewall;
  readonly state: FortiDiagnostics;
  readonly vdom: () => string;
  readonly logFormat: () => FortiLogFormat;
  readonly logContext: () => FortiLogContext;
  readonly configTree: () => FortiConfigTree;
}

import {
  renderSdwanHealthCheck, renderSdwanMembers, renderSdwanService,
} from './sdwanRenderer';
import {
  renderHaChecksum, renderHaChecksumCluster, renderHaStatus,
} from './haRenderer';
import { renderNtpStatus } from './ntpStatusRenderer';
import { renderVipList } from './vipListRenderer';
import { renderDnsProxy } from './dnsProxyRenderer';
import { renderIpFrags } from './ipFragsRenderer';
import { renderSysTop } from './sysTopRenderer';
import { renderBridgeList, renderBridgeHosts } from './brctlRenderer';
import {
  renderAggregateList, renderAggregateDetail, actorStateFlags, type AggregateView,
} from './aggregateRenderer';
import {
  renderLldpNeighborDetails, renderLldpNeighborSummary,
} from './lldpRenderer';
import { selectBundleMemberForFlow } from '@/network/lacp/loadBalance';
import { renderAutoupdateVersions } from './fortiguardRenderer';
import { renderPolicyRoutes, type ProuteContext } from './prouteRenderer';
import { renderRealServers, type VirtualServerView } from './realServerRenderer';
import { renderNic, renderNicList, type NicView } from './nicRenderer';
import { fortiLogStamp } from './timeCommands';
import {
  describeLogCategories, logFilePrefix, resolveLogCategory, typesOfLogFile,
} from '../log/logCategories';
import type { LogFilePrefix, RolledLogFile } from '../../../logging/LogDisk';
import { renderLogListing } from '../log/logFileListing';
import type { FirewallLogStore } from '../../../logging/FirewallLogStore';

function vueAgregat(nom: string, deps: FortiDiagDeps): AggregateView | null {
  const spec = deps.fw.getAggregates().get(nom);
  if (!spec) return null;
  const agent = deps.fw.getLacpAgent();
  const membres = spec.members.map((m) => {
    const info = agent.getPortInfo(m);
    const port = deps.fw.getPort(m);
    const synced = info?.bundled === true;
    return {
      name: m,
      up: port?.isOperationallyUp() === true,
      speedMbps: port?.getNegotiatedSpeed() ?? null,
      actorState: actorStateFlags(spec.lacpMode, spec.lacpSpeed, synced),
      partnerState: actorStateFlags(spec.lacpMode, spec.lacpSpeed, synced),
      aggregatorId: info?.groupId ?? 0,
      partnerMac: info?.partner?.systemId ?? '00:00:00:00:00:00',
      linkFailureCount: 0,
      permanentMac: deps.fw.permanentMacOf(m),
    };
  });
  return {
    name: nom,
    up: deps.fw.activeAggregateMembers(nom).length >= Math.max(spec.minLinks, 1),
    lacpMode: spec.lacpMode,
    lacpSpeed: spec.lacpSpeed,
    algorithm: spec.algorithm,
    minLinks: spec.minLinks,
    systemMac: agent.getConfig().systemId,
    members: membres,
  };
}

function diagnoseNetlink(rest: readonly string[], deps: FortiDiagDeps): string {
  const [family, ...tail] = rest;

  if (family === 'aggregate') {
    if (tail[0] === 'list') {
      const vues = [...deps.fw.getAggregates().keys()]
        .map(n => vueAgregat(n, deps))
        .filter((v): v is AggregateView => v !== null);
      return renderAggregateList(vues);
    }
    if (tail[0] === 'name' && tail[1] !== undefined) {
      const vue = vueAgregat(tail[1], deps);
      if (!vue) return `aggregate interface ${tail[1]} does not exist`;
      return renderAggregateDetail(vue);
    }
    return FortiMessages.unknownPath(`netlink aggregate ${tail.join(' ')}`);
  }

  if (family === 'port' && tail[0] !== undefined) {
    const vue = vueAgregat(tail[0], deps);
    if (!vue) return `aggregate interface ${tail[0]} does not exist`;
    const actifs = vue.members.filter(m => m.up).map(m => m.name);
    if (actifs.length === 0) return `no member of ${tail[0]} is up`;
    const cle = tail.slice(1).join('|');
    const elu = selectBundleMemberForFlow(actifs, cle || tail[0]);
    return `packet is transmitted from port ${elu}`;
  }

  if (family !== 'brctl') {
    return FortiMessages.unknownPath(`netlink ${rest.join(' ')}`);
  }

  const names = deps.fw.bridgeNames();
  if (tail[0] === 'list') return renderBridgeList(names);

  if (tail[0] === 'name' && tail[1] === 'host' && tail[2] !== undefined) {
    const bridge = tail[2];
    if (!names.includes(bridge)) {
      return `bridge ${bridge} does not exist`;
    }
    const vdom = bridge.slice(0, -'.b'.length);
    return renderBridgeHosts(bridge, deps.fw.getBridge(vdom).entries(), {
      numberOf: (port) => bridgePortNumber(deps, port),
    });
  }

  return FortiMessages.unknownPath(`netlink brctl ${tail.join(' ')}`);
}

function diagnoseLldpRx(rest: readonly string[], deps: FortiDiagDeps): string {
  const agent = deps.fw.getLldpAgent();
  const ports = deps.fw.getPorts().map(p => p.getName());
  if (rest[0] === 'neighbor' && rest[1] === 'summary') {
    return renderLldpNeighborSummary(agent, ports);
  }
  if (rest[0] === 'port' && rest[1] === 'neighbor' && rest[2] === 'details'
    && rest[3] !== undefined) {
    const name = rest[3];
    const index = ports.indexOf(name);
    if (index < 0) return `port ${name} does not exist`;
    return renderLldpNeighborDetails(
      agent, name, index + 1,
      deps.fw.getPort(name)?.getMAC().toString() ?? '');
  }
  return FortiMessages.unknownPath(`lldprx ${rest.join(' ')}`);
}

function nicViews(deps: FortiDiagDeps): NicView[] {
  return deps.fw.getPorts().map(port => ({
    name: port.getName(),
    currentMac: port.getMAC().toString(),
    permanentMac: deps.fw.permanentMacOf(port.getName()),
    adminUp: !port.isAdminDown(),
    linkUp: port.isOperationallyUp(),
    speed: port.getNegotiatedSpeed(),
    duplex: port.getNegotiatedDuplex() === 'full' ? 'Full' : 'Half',
    counters: port.getCounters(),
  }));
}

function virtualServers(deps: FortiDiagDeps): VirtualServerView[] {
  const views: VirtualServerView[] = [];
  for (const rule of deps.fw.getNatPolicy().ordered()) {
    const translation = rule.destinationTranslation;
    if (translation?.kind !== 'load-balance') continue;
    if (translation.pool === undefined) continue;

    const pool = deps.fw.getRealServerPool(translation.pool);
    if (!pool) continue;
    views.push({ name: translation.pool, servers: pool.view() });
  }
  return views;
}

function policyRouteContext(deps: FortiDiagDeps): ProuteContext {
  return {
    vdom: deps.vdom(),
    interfaceIndex: (name) => bridgePortNumber(deps, name),
    stamp: (at) => fortiLogStamp(deps.fw, at),
  };
}

function bridgePortNumber(deps: FortiDiagDeps, port: string): number {
  const index = deps.fw.getPorts().findIndex(known => known.getName() === port);
  return index < 0 ? 0 : index + 1;
}

export function runDiagnose(rest: readonly string[], deps: FortiDiagDeps): string {
  const [family, ...tail] = rest;
  if (family === 'sys') return diagnoseSession(tail, deps);
  if (family === 'debug') return diagnoseDebug(tail, deps);
  if (family === 'firewall') return diagnoseIprope(tail, deps);
  if (family === 'sniffer') return diagnoseSniffer(tail, deps);
  if (family === 'vpn') return diagnoseVpn(tail, deps);
  if (family === 'ipv6') return diagnoseIpv6(tail, deps);
  if (family === 'ip') return diagnoseIp(tail, deps);
  if (family === 'test') return diagnoseTest(tail, deps);
  if (family === 'netlink') return diagnoseNetlink(tail, deps);
  if (family === 'lldprx') return diagnoseLldpRx(tail, deps);
  if (family === 'snmp') return diagnoseSnmp(tail, deps);
  if (family === 'hardware') {
    if (tail[0] === 'sysinfo' && tail[1] === 'conserve') {
      return conserveModeLines(deps.fw.getSystemLoad()).join('\n');
    }
    if (tail[0] === 'sysinfo' && tail[1] === 'memory') {
      return procMeminfoLines(deps.fw.getSystemLoad()).join('\n');
    }
    if (tail[0] === 'deviceinfo' && tail[1] === 'nic') {
      const named = tail[2];
      if (named === undefined) return renderNicList(nicViews(deps));

      const nic = nicViews(deps).find(view => view.name === named);
      return nic ? renderNic(nic) : FortiMessages.unknownKey(named);
    }
    return FortiMessages.unknownPath(`hardware ${tail.join(' ')}`);
  }
  if (family === 'autoupdate') {
    if (tail[0] !== 'versions') {
      return FortiMessages.unknownPath(`autoupdate ${tail.join(' ')}`);
    }
    return renderAutoupdateVersions(deps.fw.getFortiGuard().list());
  }
  return FortiMessages.unknownPath(rest.join(' '));
}

function diagnoseCmdb(rest: readonly string[], deps: FortiDiagDeps): string {
  if (rest[0] !== 'refcnt' || rest[1] !== 'show') {
    return FortiMessages.unknownPath(`sys cmdb ${rest.join(' ')}`);
  }

  const datasource = unquote(rest[2] ?? '');
  const given = unquote(rest[3] ?? '');
  if (datasource.length === 0) {
    return FortiMessages.incomplete('`<path.object.attribute> <value>`');
  }

  const words = datasource.split(/[.:]/);
  const tree = deps.configTree();
  for (let take = Math.min(words.length, 4); take >= 1; take--) {
    const path = words.slice(0, take);
    if (!tree.spec(path)) continue;
    const key = given.length > 0 ? given : words.slice(take + 1).join('.');
    if (key.length === 0) {
      return FortiMessages.incomplete('`<path.object.attribute> <value>`');
    }
    return referencesTo(tree, path, key).map(renderReference).join('\n');
  }
  return FortiMessages.unknownPath(datasource);
}

function diagnoseCheckused(rest: readonly string[], deps: FortiDiagDeps): string {
  const datasource = unquote(rest[0] ?? '');
  const key = unquote(rest[1] ?? '');
  if (datasource.length === 0 || key.length === 0) {
    return FortiMessages.incomplete('`<path.object.mkey> <value>`');
  }

  const words = datasource.split('.');
  const tree = deps.configTree();
  for (let take = Math.min(words.length, 4); take >= 1; take--) {
    const path = words.slice(0, take);
    if (!tree.spec(path)) continue;
    const found = referencesTo(tree, path, key).map(renderReference);
    return found.join('\n');
  }
  return FortiMessages.unknownPath(datasource);
}

function diagnoseTest(rest: readonly string[], deps: FortiDiagDeps): string {
  if (rest[0] !== 'application') {
    return FortiMessages.unknownPath(`test ${rest.join(' ')}`);
  }
  if (rest[1] === 'dnsproxy') return renderDnsProxy(deps.fw, deps.vdom());
  return FortiMessages.unimplemented(`test application ${rest[1] ?? ''}`,
    'only the `dnsproxy` application is modelled in this simulator.');
}

function diagnoseSnmp(rest: readonly string[], deps: FortiDiagDeps): string {
  if (rest[0] !== 'ip' || rest[1] !== 'frags') {
    return FortiMessages.unknownPath(`snmp ${rest.join(' ')}`);
  }
  return renderIpFrags(deps.fw.getFragmentReassembly().counters());
}

function diagnoseIpv6(rest: readonly string[], deps: FortiDiagDeps): string {
  if (rest[0] === 'address' && rest[1] === 'list') {
    return renderIpv6AddressList(deps.fw.getPorts());
  }
  if (rest[0] === 'neighbor-cache' && rest[1] === 'list') {
    return renderIpv6NeighborCache(deps.fw.getIpv6().dataPlane().getNeighborCache());
  }
  return FortiMessages.unknownPath(`ipv6 ${rest.join(' ')}`);
}

function diagnoseIp(rest: readonly string[], deps: FortiDiagDeps): string {
  if (rest[0] === 'arp' && rest[1] === 'list') {
    return renderArpKernelList(
      deps.fw.getArpService(), (iface) => deps.fw.interfaceIndex(iface));
  }
  if (rest[0] !== 'address' || rest[1] !== 'list') {
    return FortiMessages.unknownPath(`ip ${rest.join(' ')}`);
  }
  const lignes: string[] = [];
  for (const iface of deps.fw.listL3Interfaces()) {
    if (!iface.ip || iface.ip === '0.0.0.0') continue;
    lignes.push(`IP=${iface.ip}->${iface.ip}/${maskToPrefix(iface.mask)}`
      + ` index=${deps.fw.interfaceIndex(iface.name)} devname=${iface.name}`);
  }
  return lignes.join('\n');
}

function maskToPrefix(mask: string | undefined): string {
  if (!mask) return '32';
  const octets = mask.split('.').map(Number);
  if (octets.length !== 4 || octets.some(o => isNaN(o))) return '32';
  let bits = 0;
  for (const o of octets) bits += ((o >>> 0).toString(2).match(/1/g) ?? []).length;
  return String(bits);
}

function diagnoseHa(rest: readonly string[], deps: FortiDiagDeps): string {
  const ha = deps.fw.getHa();

  if (rest[0] === 'status') {
    return renderHaStatus(ha, {
      model: 'FortiGate-VM64', hostname: deps.fw.getName(), now: deps.fw.now(),
    });
  }
  if (rest[0] === 'checksum' && rest[1] === 'show') return renderHaChecksum(ha);
  if (rest[0] === 'checksum' && rest[1] === 'cluster') return renderHaChecksumCluster(ha);
  if (rest[0] === 'reset-uptime') { ha.resetUptime(); return ''; }
  return FortiMessages.unknownPath(`sys ha ${rest.join(' ')}`);
}

function diagnoseSdwan(rest: readonly string[], deps: FortiDiagDeps): string {
  const table = deps.fw.getSdwan().getTable();

  if (rest[0] === 'health-check') return renderSdwanHealthCheck(table, rest[1]);
  if (rest[0] === 'member') return renderSdwanMembers(table);
  if (rest[0] === 'service') return renderSdwanService(table);
  return FortiMessages.unknownPath(`sys sdwan ${rest.join(' ')}`);
}

function currentLogFile(
  store: FirewallLogStore, prefix: LogFilePrefix,
): RolledLogFile | undefined {
  let bytes = 0;
  let at: number | null = null;
  for (const type of typesOfLogFile(prefix)) {
    bytes += store.usedBytes({ type });
    const newest = store.newestAt({ type });
    if (newest !== null && (at === null || newest > at)) at = newest;
  }
  return at === null ? undefined : { prefix, bytes, at };
}

function rollLogFiles(deps: FortiDiagDeps): string {
  const store = deps.fw.getLogStore();
  const disk = deps.fw.getLogDisk();
  for (const prefix of ['tlog', 'elog'] as const) {
    const current = currentLogFile(store, prefix);
    if (current !== undefined) disk.roll(prefix, current.bytes, current.at);
  }
  store.clear();
  return '';
}

function listLogFiles(raw: string | undefined, deps: FortiDiagDeps): string {
  if (raw === undefined || raw === '?') return describeLogCategories();
  const category = resolveLogCategory(raw);
  if (!category) {
    return FortiMessages.valueError(raw,
      `known categories:\n${describeLogCategories()}`);
  }

  const prefix = logFilePrefix(category.type);
  const current = currentLogFile(deps.fw.getLogStore(), prefix);
  return renderLogListing(
    deps.fw, deps.fw.getLogDisk().listing(prefix, current), category.name);
}

export function runExecuteLog(rest: readonly string[], deps: FortiDiagDeps): string {
  const view = deps.state.logFilter;

  if (rest[0] === 'delete-all') {
    return `${deps.fw.getLogStore().clear()} log entries deleted`;
  }
  if (rest[0] === 'delete') {
    const raw = rest[1];
    if (raw === undefined || raw === '?') return describeLogCategories();
    const category = resolveLogCategory(raw);
    if (!category) {
      return FortiMessages.valueError(raw,
        `known categories:\n${describeLogCategories()}`);
    }
    const removed = deps.fw.getLogStore().deleteMatching({
      type: category.type, subtype: category.subtype,
    });
    return `${removed} log entries deleted`;
  }
  if (rest[0] === 'roll') return rollLogFiles(deps);
  if (rest[0] === 'list') return listLogFiles(rest[1], deps);
  if (rest[0] === 'filter') return setLogFilter(rest.slice(1), deps);
  if (rest[0] !== 'display') return FortiMessages.unknownPath(`log ${rest.join(' ')}`);

  const records = deps.fw.getLogStore().select({
    type: view.category,
    subtype: view.subtype,
    level: view.level,
    fields: view.fields,
    viewLines: view.viewLines,
  });
  if (records.length === 0) return 'No matching log data.';

  const context = deps.logContext();
  const format = deps.logFormat();
  return records.map(record => formatLogRecord(record, format, context)).join('\n');
}

export function deniedLog(
  context: PacketContext, now: number, identity?: LoggedIdentity,
): FirewallLogDraft {
  const packet = context.originalPacket as IPv4Packet;
  const ports = portsOf(packet);

  return trafficDenyLog({
    now,
    sourceIP: packet.sourceIP.toString(),
    sourcePort: ports.source,
    destIP: packet.destinationIP.toString(),
    destPort: ports.destination,
    protocol: packet.protocol,
    ingressInterface: context.ingressPort,
    egressInterface: context.egressPort ?? '',
    policyId: context.matchedPolicy?.implicit === false
      ? context.matchedPolicy.id
      : '0',
    identity,
  });
}

function diagnoseSession(rest: readonly string[], deps: FortiDiagDeps): string {
  if (rest[0] === 'sdwan') return diagnoseSdwan(rest.slice(1), deps);
  if (rest[0] === 'ha') return diagnoseHa(rest.slice(1), deps);
  if (rest[0] === 'top') return renderSysTop(deps.fw);
  if (rest[0] === 'checkused') return diagnoseCheckused(rest.slice(1), deps);
  if (rest[0] === 'cmdb') return diagnoseCmdb(rest.slice(1), deps);
  if (rest[0] === 'ntp') {
    if (rest[1] !== 'status') return FortiMessages.unknownPath(`sys ${rest.join(' ')}`);
    return renderNtpStatus(deps.fw);
  }

  if (rest[0] !== 'session' && rest[0] !== 'session6') {
    return FortiMessages.unknownPath(`sys ${rest.join(' ')}`);
  }

  const family: SessionFamily = rest[0] === 'session6' ? 'ipv6' : 'ipv4';
  const verb = rest[1];
  const filter = family === 'ipv6'
    ? deps.state.session6Filter : deps.state.sessionFilter;
  const inFamily = (session: FirewallSession) =>
    sessionFamily(session) === family && sessionMatchesFilter(session, filter);

  if (verb === 'stat') {
    const view = deps.fw.getSessionTable().view();
    const active = view.find(session => sessionFamily(session) === family).length;
    const counters = view.statistics().byFamily[family];
    return `misc info: session_count=${active}`
      + ' setup_rate=0 exp_count=0 clash=0\n'
      + `sessions created=${counters.created} closed=${counters.closed}`;
  }

  if (verb === 'filter') return setSessionFilter(rest.slice(2), filter);

  if (verb === 'clear') {
    const cleared = deps.fw.getSessionTable().clearMatching(inFamily);
    return filterIsEmpty(filter)
      ? `${cleared} sessions cleared (no filter set: the whole table)`
      : `${cleared} sessions cleared`;
  }

  return renderSessionList(deps.fw.getSessionTable().view().find(inFamily), {
    now: () => deps.fw.now(),
    interfaces: deps.fw.getInterfaceTable(),
    routes: deps.fw.getRouteTable(),
    vdom: 0,
    family,
    nextHop6: (destination) => nextHopIpv6(deps, destination),
    interfaceIp6: (iface) => deps.fw.getPort(iface)?.getGlobalIPv6()?.toString() ?? null,
  });
}

function nextHopIpv6(
  deps: FortiDiagDeps, destination: string,
): { iface: string; nextHop: string } | null {
  const route = deps.fw.getIpv6().dataPlane().lookupRoute(new IPv6Address(destination));
  if (!route?.nextHop) return null;
  return { iface: route.iface, nextHop: route.nextHop.toString() };
}

export const SESSION_FILTER_FIELDS: readonly string[] =
  Object.freeze(['src', 'dst', 'sport', 'dport', 'proto', 'policy', 'vd']);

function assignSessionFilter(
  filter: SessionFilter, name: string, value: string,
): string | null {
  switch (name) {
    case 'src': filter.src = value; return null;
    case 'dst': filter.dst = value; return null;
    case 'sport': filter.sport = Number.parseInt(value, 10); return null;
    case 'dport': filter.dport = Number.parseInt(value, 10); return null;
    case 'proto': filter.proto = Number.parseInt(value, 10); return null;
    case 'policy': filter.policy = value; return null;
    case 'vd': filter.vd = Number.parseInt(value, 10); return null;
    default:
      return FortiMessages.parseError(name,
        `known filters: ${SESSION_FILTER_FIELDS.join(', ')}, clear.`);
  }
}

export function runSessionFilter(
  words: readonly string[], filter: SessionFilter, perFieldClear: boolean,
): string {
  const [name, value] = words;
  if (name === undefined) return renderSessionFilter(filter);
  if (name === 'clear') {
    if (!perFieldClear || value === undefined || value === 'all') {
      clearFilter(filter);
      return '';
    }
    if (!SESSION_FILTER_FIELDS.includes(value)) {
      return FortiMessages.parseError(value,
        `known filters: ${SESSION_FILTER_FIELDS.join(', ')}, all.`);
    }
    delete filter[value as keyof SessionFilter];
    return '';
  }
  if (value === undefined) return FortiMessages.incomplete('the filter value');
  return assignSessionFilter(filter, name, value) ?? '';
}

function setSessionFilter(words: readonly string[], filter: SessionFilter): string {
  return runSessionFilter(words, filter, false);
}

function renderSessionFilter(filter: SessionFilter): string {
  const shown = (value: unknown): string =>
    value === undefined || value === null || Number.isNaN(value) ? 'any' : String(value);

  return [
    `vd: ${shown(filter.vd)}`,
    `sintf: any`,
    `dintf: any`,
    `src: ${shown(filter.src)}`,
    `dst: ${shown(filter.dst)}`,
    `src-port: ${shown(filter.sport)}`,
    `dst-port: ${shown(filter.dport)}`,
    `proto: ${shown(filter.proto)}`,
    `policy: ${shown(filter.policy)}`,
  ].join('\n');
}

function diagnoseDebug(rest: readonly string[], deps: FortiDiagDeps): string {
  const state = deps.state.debugFlow;

  if (rest[0] === 'reset') { deps.state.resetDebug(); return ''; }
  if (rest[0] === 'enable') {
    state.enabled = true;
    const text = renderDebugFlow(deps.fw.recentTraces(), state, deps.vdom());
    state.nextTraceId += Math.max(1, countTraces(text));
    return state.showConsole ? text : '';
  }
  if (rest[0] === 'disable') { state.enabled = false; return ''; }
  if (rest[0] !== 'flow') return FortiMessages.unknownPath(rest.join(' '));

  if (rest[1] === 'filter') return setFlowFilter(rest.slice(2), deps);
  if (rest[1] === 'show') return setFlowShow(rest.slice(2), deps);
  if (rest[1] === 'trace') {
    if (rest[2] === 'stop') { state.traceCount = 0; return ''; }
    const count = Number.parseInt(rest[3] ?? '', 10);
    state.traceCount = Number.isFinite(count) ? count : 1;
    return '';
  }
  return FortiMessages.unknownPath(rest.join(' '));
}

function setFlowShow(words: readonly string[], deps: FortiDiagDeps): string {
  const [option, value] = words;
  if (option === undefined) {
    return FortiMessages.parseError('show',
      'expected `function-name`, `console` or `iprope`, then `enable` or `disable`.');
  }
  if (value !== 'enable' && value !== 'disable') {
    return FortiMessages.parseError(value ?? option,
      `\`diagnose debug flow show ${option}\` takes \`enable\` or \`disable\`.`);
  }
  const on = value === 'enable';
  if (option === 'function-name') {
    deps.state.debugFlow.showFunctionName = on;
    return '';
  }
  if (option === 'console') {
    deps.state.debugFlow.showConsole = on;
    return '';
  }
  if (option === 'iprope') {
    return FortiMessages.commandFail(
      '`show iprope` exists on a real FortiGate; this simulator has no iprope '
      + 'lookup lines to add to the trace, and the policy it matched is already named.');
  }
  return FortiMessages.parseError(option,
    'expected `function-name`, `console` or `iprope`.');
}

function renderFlowFilter(deps: FortiDiagDeps): string {
  const filter = deps.state.debugFlow.filter;
  const shown = (value: unknown, fallback: string): string =>
    value === undefined || value === null || Number.isNaN(value)
      ? fallback : String(value);

  return [
    'vd: any',
    `addr: ${shown(filter.addr, '0.0.0.0')}`,
    `saddr: ${shown(filter.saddr, '0.0.0.0')}`,
    `daddr: ${shown(filter.daddr, '0.0.0.0')}`,
    `port: ${shown(filter.port, '0')}`,
    `proto: ${shown(filter.proto, '0')}`,
  ].join('\n');
}

function setFlowFilter(words: readonly string[], deps: FortiDiagDeps): string {
  const [name, value] = words;
  if (name === undefined) return renderFlowFilter(deps);
  if (name === 'clear') { deps.state.debugFlow.filter = {}; return ''; }
  if (value === undefined) return FortiMessages.incomplete('the filter value');

  const filter = deps.state.debugFlow.filter;
  switch (name) {
    case 'addr': filter.addr = value; return '';
    case 'saddr': filter.saddr = value; return '';
    case 'daddr': filter.daddr = value; return '';
    case 'port': filter.port = Number.parseInt(value, 10); return '';
    case 'proto': filter.proto = Number.parseInt(value, 10); return '';
    default:
      return FortiMessages.parseError(name,
        'known filters: addr, saddr, daddr, port, proto, clear.');
  }
}

function diagnoseFqdnList(deps: FortiDiagDeps): string {
  const lignes: string[] = [];
  for (const entry of deps.fw.getDnsClient().entries()) {
    lignes.push(`${entry.fqdn}:`);
    for (const address of entry.addresses) {
      lignes.push(`\t${address}\t${entry.ttl}`);
    }
  }
  return lignes.join('\n');
}

function diagnoseIprope(rest: readonly string[], deps: FortiDiagDeps): string {
  if (rest[0] === 'auth') return diagnoseAuth(rest.slice(1), deps);
  if (rest[0] === 'vip') {
    if (rest[1] === 'list') {
      return renderVipList(deps.fw.getNatPolicy().ordered(), deps.vdom());
    }
    if (rest[1] === 'realserver') {
      if (rest[2] === 'list') {
        return renderRealServers(virtualServers(deps), { vdom: deps.vdom() });
      }
      if (rest[2] === 'clear') {
        for (const virtual of virtualServers(deps)) {
          deps.fw.getRealServerPool(virtual.name)?.clearStats();
        }
        return '';
      }
    }
    return FortiMessages.unknownPath(`firewall ${rest.join(' ')}`);
  }
  if (rest[0] === 'fqdn') {
    if (rest[1] !== 'list') return FortiMessages.unknownPath(`firewall ${rest.join(' ')}`);
    return diagnoseFqdnList(deps);
  }
  if (rest[0] === 'proute') {
    if (rest[1] === 'list') {
      return renderPolicyRoutes(
        deps.fw.getPolicyRoutes().ordered(), policyRouteContext(deps));
    }
    if (rest[1] === 'clear') {
      deps.fw.getPolicyRoutes().clearCounters(rest[2]);
      return '';
    }
    return FortiMessages.unknownPath(`firewall ${rest.join(' ')}`);
  }
  if (rest[0] !== 'iprope') return FortiMessages.unknownPath(rest.join(' '));

  const options = { zones: deps.fw.getZoneTable(), vdom: 0 };
  const rules = deps.fw.getPolicyStore().ordered();

  if (rest[1] === 'list') return renderIpropeList(rules, options);
  if (rest[1] === 'show') {
    const shown = renderIpropeShow(rest[2] ?? '', rest[3] ?? '', rules, options);
    return shown ?? FortiMessages.unknownKey(`${rest[2] ?? ''} ${rest[3] ?? ''}`.trim());
  }
  return FortiMessages.unknownPath(rest.join(' '));
}

function diagnoseAuth(rest: readonly string[], deps: FortiDiagDeps): string {
  const identities = deps.fw.getIdentityTable();

  if (rest[0] === 'list') {
    return renderAuthList(identities, deps.state.authFilter ?? {});
  }
  if (rest[0] === 'clear') {
    identities.clear();
    return '';
  }
  if (rest[0] === 'filter') {
    if (rest[1] === 'clear') {
      deps.state.authFilter = {};
      return '';
    }
    deps.state.authFilter = parseAuthFilter(rest.slice(1));
    return '';
  }
  return FortiMessages.unknownPath(`firewall auth ${rest.join(' ')}`);
}

function diagnoseVpn(rest: readonly string[], deps: FortiDiagDeps): string {
  if (rest[0] === 'ike') return diagnoseIke(rest.slice(1), deps);
  if (rest[0] !== 'tunnel') return FortiMessages.unknownPath(`vpn ${rest.join(' ')}`);

  const tunnels = deps.fw.getTunnelTable();
  if (rest[1] === 'list') return renderVpnTunnelList(tunnels, deps.fw.now());
  if (rest[1] === 'up') {
    const name = rest[2];
    if (name === undefined) return FortiMessages.incomplete('the tunnel name');
    if (!tunnels.getPhase1(name)) return FortiMessages.unknownKey(name);
    if (deps.fw.bringUpIpsecTunnel(name)) return '';

    const failure = tunnels.stateOf(name)?.failure;
    return FortiMessages.commandFail(failure === undefined || failure === null
      ? `tunnel \`${name}\` did not come up.`
      : `tunnel \`${name}\` did not come up: ${failure}.`);
  }
  if (rest[1] === 'flush') {
    for (const tunnel of tunnels.all()) deps.fw.clearIpsecGateway(tunnel.name);
    return '';
  }
  return FortiMessages.unknownPath(`vpn tunnel ${rest.slice(1).join(' ')}`);
}

function diagnoseIke(rest: readonly string[], deps: FortiDiagDeps): string {
  if (rest[0] !== 'gateway') return FortiMessages.unknownPath(`vpn ike ${rest.join(' ')}`);

  const tunnels = deps.fw.getTunnelTable();
  if (rest[1] === 'list') {
    if (rest[2] === 'name') {
      if (rest[3] === undefined) return FortiMessages.incomplete('a gateway name');
      if (!tunnels.getPhase1(rest[3])) return FortiMessages.unknownKey(rest[3]);
      return renderIkeGatewayList(tunnels, deps.fw.now(), deps.fw, rest[3]);
    }
    return renderIkeGatewayList(tunnels, deps.fw.now(), deps.fw);
  }
  if (rest[1] === 'flush') {
    for (const tunnel of tunnels.all()) deps.fw.clearIpsecGateway(tunnel.name);
    return '';
  }
  if (rest[1] === 'clear') {
    if (rest[2] !== 'name' || rest[3] === undefined) {
      return FortiMessages.incomplete('`name <gateway>`');
    }
    if (!tunnels.getPhase1(rest[3])) return FortiMessages.unknownKey(rest[3]);
    deps.fw.clearIpsecGateway(rest[3]);
    return '';
  }
  return FortiMessages.unknownPath(`vpn ike gateway ${rest.slice(1).join(' ')}`);
}

export interface SnifferPlan {
  readonly iface: string;
  readonly expression: string;
  readonly verbosity: number;
  readonly count: number;
  readonly filter: CaptureFilter;
}

export function parseSnifferPlan(
  rest: readonly string[], knownInterface: (name: string) => boolean,
): SnifferPlan | null {
  if (rest[0] !== 'packet') return null;
  const iface = rest[1];
  if (iface === undefined) return null;
  if (iface !== 'any' && !knownInterface(iface)) return null;

  const parsed = splitSnifferArguments(rest.slice(2));
  const filter = parseCaptureFilter(parsed.expression);
  if (filter === null) return null;
  return { iface, filter, ...parsed };
}

function diagnoseSniffer(rest: readonly string[], deps: FortiDiagDeps): string {
  if (rest[0] !== 'packet') return FortiMessages.unknownPath(rest.join(' '));

  const iface = rest[1];
  if (iface === undefined) return FortiMessages.incomplete('an interface name');
  if (iface !== 'any' && deps.fw.getPort(iface) === undefined) {
    return FortiMessages.unknownKey(iface);
  }

  const parsed = splitSnifferArguments(rest.slice(2));
  const filter = parseCaptureFilter(parsed.expression);
  if (filter === null) {
    return FortiMessages.valueError(
      parsed.expression, 'unsupported sniffer filter expression.');
  }

  const { expression, verbosity, count } = parsed;
  const frames = deps.fw.getPacketCapture().select({ iface, filter, limit: count });
  const startedAt = frames[0]?.at ?? deps.fw.now();

  return renderSniffer({ iface, expression, verbosity, count }, frames, startedAt);
}

function setLogFilter(words: readonly string[], deps: FortiDiagDeps): string {
  const view = deps.state.logFilter;
  const [name, ...tail] = words;

  if (name === undefined) return FortiMessages.incomplete('a filter criterion');
  if (name === 'reset') { deps.state.clearLogFilter(); return ''; }

  if (name === 'category') {
    const raw = tail[0];
    if (raw === '?') return describeLogCategories();
    const category = raw === undefined ? undefined : resolveLogCategory(raw);
    if (!category) {
      return FortiMessages.valueError(raw ?? '',
        `known categories:\n${describeLogCategories()}`);
    }
    view.category = category.type;
    view.subtype = category.subtype;
    return '';
  }
  if (name === 'view-lines') {
    const lines = Number.parseInt(tail[0] ?? '', 10);
    if (!Number.isFinite(lines)) {
      return FortiMessages.valueError(tail[0] ?? '', 'a line count is expected.');
    }
    view.viewLines = lines;
    return '';
  }
  if (name === 'field') {
    const [field, value] = tail;
    if (field === undefined) return FortiMessages.incomplete('a field name');
    if (value === undefined) { view.fields.delete(field); return ''; }
    view.fields.set(field, unquote(value));
    return '';
  }
  return FortiMessages.parseError(name,
    'known filters: category, field, view-lines, reset.');
}

export function splitSnifferArguments(
  words: readonly string[],
): { expression: string; verbosity: number; count: number } {
  const joined = words.join(' ');
  const quoted = /^\s*(['"])([\s\S]*?)\1\s*/.exec(joined);

  const expression = quoted
    ? quoted[2]
    : (words[0] === undefined ? '' : unquote(words[0]));
  const tail = quoted
    ? joined.slice(quoted[0].length).split(/\s+/).filter(Boolean)
    : words.slice(1);

  const verbosity = Number.parseInt(tail[0] ?? '1', 10) || 1;
  const count = Number.parseInt(tail[1] ?? '0', 10) || 0;
  return { expression: expression === 'none' ? '' : expression, verbosity, count };
}

function countTraces(rendered: string): number {
  const seen = new Set<string>();
  for (const match of rendered.matchAll(/trace_id=(\d+)/g)) seen.add(match[1]);
  return seen.size;
}
