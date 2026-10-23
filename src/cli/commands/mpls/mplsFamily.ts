import type { CommandSpec } from '@/cli/CommandTable';
import type { LdpEngine } from '@/network/ldp/LdpEngine';
import type { MplsEngine } from '@/network/mpls/MplsEngine';
import type { RouterMplsOam } from '@/network/devices/router/MplsOam';
import { PadInstruction, ReplyMode, type TargetFec } from '@/network/mpls/oam/EchoCodec';
import { formatPingMpls, formatTraceMpls } from './mplsOamShow';
import type { MplsLabel } from '@/network/mpls/MplsLabel';
import { LABEL_RANGE_DEFAULT_MAX, LABEL_RANGE_DEFAULT_MIN } from '@/network/mpls/Lfib';
import { IPAddress } from '@/network/core/types';
import type { PseudowireEngine } from '@/network/pw/PseudowireEngine';
import {
  formatLdpBackoff, formatLdpBindings, formatLdpCapabilities, formatLdpDiscovery, formatLdpNeighbors, formatLdpParameters,
  formatMplsForwardingTable, formatMplsInterfaces,
  type LdpBindingView, type LdpNeighborView, type MplsForwardingView, type MplsInterfaceRow,
} from './mplsShow';

export interface MplsShellHost {
  present(): boolean;
  mpls(): MplsEngine;
  ldp(): LdpEngine;
  pseudowires(): PseudowireEngine;
  selectedInterfaces(): string[];
  interfaceNames(): string[];
  interfaceIsUp(name: string): boolean;
  setRouterIdSource(iface: string | null, force: boolean): void;
  resolveInterface(text: string): string | null;
  routerIdSourceText(): string | null;
  interfaceMtu(name: string): number;
  interfaceMac(name: string): string | null;
  neighbourMac(address: string): string | null;
  oam(): RouterMplsOam;
  vpnLocalLabels(): ReadonlyArray<{ readonly label: MplsLabel; readonly network: string; readonly length: number; readonly vrf: string }>;
}

const GLOBAL = Object.freeze(['config']);
const INTERFACE = Object.freeze(['config-if', 'config-subif']);
const GLOBAL_OR_INTERFACE = Object.freeze(['config', 'config-if', 'config-subif']);
const SHOW = Object.freeze(['user', 'privileged']);
const PRIVILEGED = Object.freeze(['privileged']);
const DEFAULT_HELLO_INTERVAL_SECONDS = 5;
const DEFAULT_HELLO_HOLD_SECONDS = 15;
const DEFAULT_MAX_HOPS = 254;
const DEFAULT_SESSION_HOLD_SECONDS = 180;
const DEFAULT_TARGETED_HOLD_SECONDS = 90;
const DEFAULT_TARGETED_INTERVAL_SECONDS = 10;
const DEFAULT_BACKOFF_INITIAL_SECONDS = 15;
const DEFAULT_BACKOFF_MAXIMUM_SECONDS = 120;

export function mplsNeighborViews(host: MplsShellHost, filter: { readonly address?: string; readonly iface?: string } = {}): LdpNeighborView[] {
  const engine = host.ldp();
  const config = engine.config;
  return engine.sessions().filter(session => session.state === 'operational' && session.peer).map(session => {
    const peer = session.peer!;
    const sources = engine.adjacencies().filter(a => a.peer.equals(peer)).map(a => ({
      targeted: a.targeted, label: a.iface, source: a.source.toString(), role: engine.targetedRole(a.source),
      localAddress: engine.localId.lsrId.toString(), holdMs: a.holdSeconds * 1000,
      intervalMs: (a.targeted ? config.targetedHelloIntervalSeconds : config.helloIntervalSeconds) * 1000,
    }));
    const keepAliveSeconds = session.negotiated?.keepAliveTimeSeconds ?? config.keepAliveSeconds;
    return {
      peerId: peer.toString(), localId: engine.localId.toString(),
      remoteTransport: session.socket.remoteIp, remotePort: session.socket.remotePort,
      localTransport: session.socket.localIp, localPort: session.socket.localPort,
      state: 'Oper', mode: session.negotiated?.advertisementMode ?? 'unsolicited',
      messagesSent: session.messagesSent, messagesReceived: session.messagesReceived,
      lastRevisionSent: engine.lastRevisionSent(peer),
      upMs: session.operationalSinceMs === null ? 0 : Math.max(0, engine.nowMs() - session.operationalSinceMs),
      uid: session.uid, peerIndex: session.peerIndex,
      peerHoldMs: keepAliveSeconds * 1000, keepAliveMs: Math.floor(keepAliveSeconds / 3) * 1000,
      loop: config.loopDetection ? {
        peer: session.peerLoopDetection, local: true, peerLimit: session.peerPathVectorLimit, localLimit: config.pathVectorLimit,
      } : null,
      sources, addresses: [...session.peerAddresses.keys()].sort(addressOrder),
    };
  }).filter(view => (filter.address === undefined || view.peerId.startsWith(`${filter.address}:`) || view.addresses.includes(filter.address))
    && (filter.iface === undefined || view.sources.some(source => source.label === filter.iface)));
}

function addressOrder(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export interface BindingFilter {
  readonly network?: string;
  readonly length?: number;
  readonly longerPrefixes?: boolean;
  readonly localLabel?: number;
  readonly remoteLabel?: number;
  readonly neighbor?: string;
  readonly localOnly?: boolean;
}

function prefixMatches(prefix: string, length: number, filter: BindingFilter): boolean {
  if (filter.network === undefined || filter.length === undefined) return true;
  if (!filter.longerPrefixes) return prefix === filter.network && length === filter.length;
  if (length < filter.length) return false;
  const mask = filter.length === 0 ? 0 : (0xffffffff << (32 - filter.length)) >>> 0;
  return ((ipToInt(prefix) & mask) >>> 0) === ((ipToInt(filter.network) & mask) >>> 0);
}

function ipToInt(text: string): number {
  return text.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

export function mplsBindingViews(host: MplsShellHost, filter: BindingFilter = {}): LdpBindingView[] {
  const engine = host.ldp();
  const peers = engine.sessions().filter(session => session.state === 'operational' && session.peer);
  return engine.bindings().map(binding => ({
    prefix: binding.fec.prefix.toString(), length: binding.fec.length, revision: binding.revision, local: binding.label,
    advertisedTo: engine.advertisedTo(binding.fec.key).map(peer => peer.toString()),
    remote: peers.flatMap(session => {
      const label = engine.remoteBindings(session.peer!).get(binding.fec.key);
      return label ? [{ peerId: session.peer!.toString(), label }] : [];
    }),
  })).filter(view => prefixMatches(view.prefix, view.length, filter)
    && (filter.localLabel === undefined || view.local.value === filter.localLabel)
    && (filter.remoteLabel === undefined || view.remote.some(remote => remote.label.value === filter.remoteLabel))
    && (filter.neighbor === undefined || view.remote.some(remote => remote.peerId.startsWith(`${filter.neighbor}:`)))
  ).map(view => filter.neighbor === undefined ? view
    : { ...view, remote: view.remote.filter(remote => remote.peerId.startsWith(`${filter.neighbor}:`)) })
    .sort((a, b) => addressOrder(a.prefix, b.prefix) || a.length - b.length);
}

export interface ForwardingFilter {
  readonly network?: string;
  readonly length?: number;
  readonly iface?: string;
  readonly label?: number;
  readonly nextHop?: string;
  readonly vrf?: string;
}

export function mplsForwardingViews(host: MplsShellHost, filter: ForwardingFilter = {}, detail = false): MplsForwardingView[] {
  const mpls = host.mpls();
  const labelled: MplsForwardingView[] = host.ldp().forwardingRows().map(row => {
    const stack = row.outgoing === 'none' ? [] : [row.outgoing.value];
    return {
      localLabel: row.localLabel, outgoing: row.outgoing, prefix: `${row.fec.prefix}/${row.fec.length}`,
      bytes: mpls.bytesSwitched(row.localLabel), iface: row.iface, nextHop: String(row.nextHop),
      ...(detail ? { detail: forwardingDetail(host, row.iface, String(row.nextHop), stack, null) } : {}),
    };
  });
  const vpn: MplsForwardingView[] = host.vpnLocalLabels().map(entry => ({
    localLabel: entry.label, outgoing: 'aggregate' as const, prefix: `${entry.network}/${entry.length}[V]`,
    bytes: mpls.bytesSwitched(entry.label), iface: entry.vrf, nextHop: '',
    ...(detail ? { detail: { encapsulationBytes: 0, mtu: 0, labelStack: [], header: '', vpn: entry.vrf } } : {}),
  }));
  return [...labelled, ...vpn].filter(row => {
    const [network, length] = row.prefix.replace('[V]', '').split('/');
    return (filter.network === undefined || (network === filter.network && Number(length) === filter.length))
      && (filter.iface === undefined || row.iface === filter.iface)
      && (filter.label === undefined || row.localLabel.value === filter.label)
      && (filter.nextHop === undefined || row.nextHop === filter.nextHop)
      && (filter.vrf === undefined || row.iface === filter.vrf);
  }).sort((a, b) => a.localLabel.value - b.localLabel.value);
}

function forwardingDetail(host: MplsShellHost, iface: string, nextHop: string, stack: readonly number[], vpn: string | null) {
  const mac = host.interfaceMac(iface);
  const destination = host.neighbourMac(nextHop);
  const header = destination === null || mac === null ? '' : `${destination}${mac}8847`.replace(/[:.-]/g, '').toUpperCase();
  const explicit = stack.filter(label => label !== 3);
  return { encapsulationBytes: header.length / 2, mtu: host.interfaceMtu(iface) + 4 - 4 * explicit.length, labelStack: stack, header, vpn };
}

function ldpFec(text: string): TargetFec | null {
  const [address, length] = text.split('/');
  const bits = Number(length);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address) || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return { kind: 'ldp-ipv4', prefix: new IPAddress(address), length: bits };
}

const DEFAULT_PING_REPEAT = 5;
const DEFAULT_PING_SIZE = 100;
const DEFAULT_OAM_TIMEOUT_SECONDS = 2;

function echoOptions(args: Record<string, string>) {
  return {
    replyMode: args.mode === 'router-alert' ? ReplyMode.UdpRouterAlert : ReplyMode.Udp,
    ...(args.dscp === undefined ? {} : { replyTosByte: Number(args.dscp) << 2 }),
    ...(args.reply !== 'pad-tlv' ? {} : { pad: { instruction: PadInstruction.CopyToReply, length: 1 } }),
    ...(args.exp === undefined ? {} : { trafficClass: Number(args.exp) }),
  };
}

function runPingMpls(host: MplsShellHost, args: Record<string, string>): string {
  const fec = ldpFec(String(args.target));
  if (fec === null) return "% Invalid input detected at '^' marker.";
  const count = args.count === undefined ? DEFAULT_PING_REPEAT : Number(args.count);
  const size = args.size === undefined ? DEFAULT_PING_SIZE : Number(args.size);
  const timeoutSeconds = args.timeout === undefined ? DEFAULT_OAM_TIMEOUT_SECONDS : Number(args.timeout);
  const outcomes = [];
  for (let attempt = 0; attempt < count; attempt++) {
    const outcome = host.oam().ping([fec], {
      ...echoOptions(args), targetSize: size,
      ...(args.ttl === undefined ? {} : { ttl: Number(args.ttl) }),
      ...(args.dsmap === undefined ? {} : { ddmap: host.oam().firstHopMapping([fec]) ?? undefined }),
    });
    outcomes.push({ outcome, counted: outcome.kind !== 'reply' || outcome.reply.roundTripMs <= timeoutSeconds * 1000 });
  }
  const settled = outcomes.map(entry => entry.counted ? entry : { outcome: { kind: 'timeout' as const }, counted: false });
  return formatPingMpls({ count, size, target: String(args.target).split('/')[0], timeoutSeconds }, settled, args.verbose !== undefined);
}

function runTraceMpls(host: MplsShellHost, args: Record<string, string>): string {
  const fec = ldpFec(String(args.target));
  if (fec === null) return "% Invalid input detected at '^' marker.";
  const origin = host.oam().describeFirstHop([fec]);
  const timeoutSeconds = args.timeout === undefined ? DEFAULT_OAM_TIMEOUT_SECONDS : Number(args.timeout);
  if (origin === null) {
    return `Tracing MPLS Label Switched Path to ${args.target}, timeout is ${timeoutSeconds} seconds\nQ 1`;
  }
  const hops = host.oam().traceroute([fec], { ...echoOptions(args), ...(args.ttl === undefined ? {} : { maxTtl: Number(args.ttl) }) });
  return formatTraceMpls({ target: String(args.target), timeoutSeconds }, {
    interfaceAddress: String(origin.interfaceAddress), mtu: origin.mtu, labels: origin.labels,
  }, hops);
}

function maskLength(text: string): number | null {
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    return value <= 32 ? value : null;
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(text)) return null;
  const bits = text.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
  const ones = bits.toString(2).replace(/0+$/, '');
  return /^1*$/.test(ones) && bits.toString(2).padStart(32, '0').indexOf('01') < 0 ? ones.length : null;
}

export function mplsFamily(host: () => MplsShellHost): CommandSpec[] {
  return [
    {
      id: 'mpls-ip-interface',
      path: ['mpls', 'ip'],
      description: 'Configure dynamic MPLS forwarding',
      undoDescription: 'Disable dynamic MPLS forwarding',
      modes: INTERFACE, minPrivilege: 15,
      run: () => {
        for (const iface of host().selectedInterfaces()) host().ldp().enableInterface(iface);
        return '';
      },
      undo: () => {
        for (const iface of host().selectedInterfaces()) host().ldp().disableInterface(iface);
        return '';
      },
    },
    {
      id: 'mpls-ip-global',
      path: ['mpls', 'ip'],
      description: 'Enable dynamic MPLS forwarding',
      undoDescription: 'Disable dynamic MPLS forwarding on the whole router',
      modes: GLOBAL, minPrivilege: 15,
      run: () => { host().ldp().setGloballyEnabled(true); return ''; },
      undo: () => { host().ldp().setGloballyEnabled(false); return ''; },
    },
    {
      id: 'mpls-label-protocol-ldp',
      path: ['mpls', 'label', 'protocol', 'ldp'],
      description: 'Use LDP (RFC 5036) for label distribution',
      modes: GLOBAL_OR_INTERFACE, minPrivilege: 15,
      run: () => '',
    },
    {
      id: 'mpls-ip-propagate-ttl',
      path: ['mpls', 'ip', 'propagate-ttl'],
      description: 'Propagate IP TTL into the label stack',
      undoDescription: 'Do not propagate the IP TTL: labels start at 255',
      modes: GLOBAL, minPrivilege: 15,
      run: () => { host().mpls().propagateTtl = true; return ''; },
      undo: () => { host().mpls().propagateTtl = false; return ''; },
    },
    {
      id: 'mpls-ldp-router-id',
      path: ['mpls', 'ldp', 'router-id', { name: 'iface', type: 'INTERFACE', description: 'Interface whose address is the LDP router id' },
        { name: 'force', type: 'ENUM', optional: true, values: [{ keyword: 'force', description: 'Apply immediately, resetting LDP sessions' }] }],
      description: 'Configure the LDP router id',
      undoDescription: 'Restore the default LDP router id selection',
      modes: GLOBAL, minPrivilege: 15, undoOmitsArguments: true,
      run: (_session, args) => {
        const iface = host().resolveInterface(String(args.iface));
        if (!iface) return '% Invalid interface';
        host().setRouterIdSource(iface, args.force === 'force');
        return '';
      },
      undo: () => { host().setRouterIdSource(null, false); return ''; },
    },
    {
      id: 'mpls-label-range',
      path: ['mpls', 'label', 'range',
        { name: 'minimum', type: 'INT', range: [16, 1048575], description: 'Smallest label allowed in the label space' },
        { name: 'maximum', type: 'INT', range: [16, 1048575], description: 'Largest label allowed in the label space' }],
      description: 'Configure the range of local labels',
      undoDescription: 'Restore the default range of local labels',
      modes: GLOBAL, minPrivilege: 15, undoOmitsArguments: true,
      run: (_session, args) => {
        if (Number(args.minimum) >= Number(args.maximum)) return "% Invalid input detected at '^' marker.";
        host().mpls().lfib.setLabelRange(Number(args.minimum), Number(args.maximum));
        return '';
      },
      undo: () => { host().mpls().lfib.setLabelRange(LABEL_RANGE_DEFAULT_MIN, LABEL_RANGE_DEFAULT_MAX); return ''; },
    },
    {
      id: 'mpls-ldp-loop-detection',
      path: ['mpls', 'ldp', 'loop-detection'],
      description: 'Enable the LDP optional loop detection mechanism',
      undoDescription: 'Disable LDP loop detection',
      modes: GLOBAL, minPrivilege: 15,
      run: () => { host().ldp().setLoopDetection(true); return ''; },
      undo: () => { host().ldp().setLoopDetection(false); return ''; },
    },
    {
      id: 'mpls-ldp-maxhops',
      path: ['mpls', 'ldp', 'maxhops', { name: 'hops', type: 'INT', range: [1, 255], description: 'Maximum hop count' }],
      description: 'Limit the number of hops permitted in an LSP',
      undoDescription: 'Restore the default maximum hop count',
      modes: GLOBAL, minPrivilege: 15, undoOmitsArguments: true,
      run: (_session, args) => { host().ldp().setMaxHops(Number(args.hops)); return ''; },
      undo: () => { host().ldp().setMaxHops(DEFAULT_MAX_HOPS); return ''; },
    },
    {
      id: 'mpls-ldp-path-vector-maxlength',
      path: ['mpls', 'ldp', 'path-vector', 'maxlength', { name: 'length', type: 'INT', range: [0, 254], description: 'Maximum number of router IDs in the path vector (0 disables it)' }],
      description: 'Set the maximum path vector length',
      undoDescription: 'Track the maximum hop count again',
      modes: GLOBAL, minPrivilege: 15, undoOmitsArguments: true,
      run: (_session, args) => { host().ldp().setPathVectorLimit(Number(args.length)); return ''; },
      undo: () => { host().ldp().setPathVectorLimit(null); return ''; },
    },
    {
      id: 'mpls-ldp-holdtime',
      path: ['mpls', 'ldp', 'holdtime', { name: 'seconds', type: 'INT', range: [15, 65535], description: 'Session hold time in seconds' }],
      description: 'Change the time an LDP session is kept without messages',
      undoDescription: 'Restore the default session hold time',
      modes: GLOBAL, minPrivilege: 15, undoOmitsArguments: true,
      run: (_session, args) => { host().ldp().setHoldTime(Number(args.seconds)); return ''; },
      undo: () => { host().ldp().setHoldTime(DEFAULT_SESSION_HOLD_SECONDS); return ''; },
    },
    {
      id: 'mpls-ldp-discovery-targeted-hello-holdtime',
      path: ['mpls', 'ldp', 'discovery', 'targeted-hello', 'holdtime', { name: 'seconds', type: 'INT', range: [1, 65535], description: 'Hold time in seconds' }],
      description: 'LDP discovery targeted Hello hold time',
      undoDescription: 'Restore the default targeted Hello hold time',
      modes: GLOBAL, minPrivilege: 15, undoOmitsArguments: true,
      run: (_session, args) => { host().ldp().setTargetedHelloTimers(null, Number(args.seconds)); return ''; },
      undo: () => { host().ldp().setTargetedHelloTimers(null, DEFAULT_TARGETED_HOLD_SECONDS); return ''; },
    },
    {
      id: 'mpls-ldp-discovery-targeted-hello-interval',
      path: ['mpls', 'ldp', 'discovery', 'targeted-hello', 'interval', { name: 'seconds', type: 'INT', range: [1, 65535], description: 'Interval in seconds' }],
      description: 'LDP discovery targeted Hello interval',
      undoDescription: 'Restore the default targeted Hello interval',
      modes: GLOBAL, minPrivilege: 15, undoOmitsArguments: true,
      run: (_session, args) => { host().ldp().setTargetedHelloTimers(Number(args.seconds), null); return ''; },
      undo: () => { host().ldp().setTargetedHelloTimers(DEFAULT_TARGETED_INTERVAL_SECONDS, null); return ''; },
    },
    {
      id: 'mpls-ldp-backoff',
      path: ['mpls', 'ldp', 'backoff',
        { name: 'initial', type: 'INT', range: [5, 2147483], description: 'Initial backoff in seconds' },
        { name: 'maximum', type: 'INT', range: [5, 2147483], description: 'Maximum backoff in seconds' }],
      description: 'Configure the LDP session setup backoff',
      undoDescription: 'Restore the default backoff',
      modes: GLOBAL, minPrivilege: 15, undoOmitsArguments: true,
      run: (_session, args) => {
        if (Number(args.initial) > Number(args.maximum)) return "% Invalid input detected at '^' marker.";
        host().ldp().setBackoff(Number(args.initial), Number(args.maximum));
        return '';
      },
      undo: () => { host().ldp().setBackoff(DEFAULT_BACKOFF_INITIAL_SECONDS, DEFAULT_BACKOFF_MAXIMUM_SECONDS); return ''; },
    },
    {
      id: 'mpls-ldp-explicit-null',
      path: ['mpls', 'ldp', 'explicit-null'],
      description: 'Advertise Explicit Null instead of Implicit Null',
      undoDescription: 'Advertise Implicit Null again',
      modes: GLOBAL, minPrivilege: 15,
      run: () => { host().ldp().setExplicitNull(true); return ''; },
      undo: () => { host().ldp().setExplicitNull(false); return ''; },
    },
    {
      id: 'mpls-ldp-discovery-hello-holdtime',
      path: ['mpls', 'ldp', 'discovery', 'hello', 'holdtime', { name: 'seconds', type: 'INT', range: [1, 65535], description: 'Hold time in seconds' }],
      description: 'LDP discovery link Hello hold time',
      undoDescription: 'Restore the default hold time',
      modes: GLOBAL, minPrivilege: 15, undoOmitsArguments: true,
      run: (_session, args) => { host().ldp().setHelloTimers(null, Number(args.seconds)); return ''; },
      undo: () => { host().ldp().setHelloTimers(null, DEFAULT_HELLO_HOLD_SECONDS); return ''; },
    },
    {
      id: 'mpls-ldp-discovery-hello-interval',
      path: ['mpls', 'ldp', 'discovery', 'hello', 'interval', { name: 'seconds', type: 'INT', range: [1, 65535], description: 'Interval in seconds' }],
      description: 'LDP discovery link Hello interval',
      undoDescription: 'Restore the default interval',
      modes: GLOBAL, minPrivilege: 15, undoOmitsArguments: true,
      run: (_session, args) => { host().ldp().setHelloTimers(Number(args.seconds), null); return ''; },
      undo: () => { host().ldp().setHelloTimers(DEFAULT_HELLO_INTERVAL_SECONDS, null); return ''; },
    },
    {
      id: 'mpls-ldp-neighbor-targeted',
      path: ['mpls', 'ldp', 'neighbor', { name: 'address', type: 'IP_ADDR', description: 'LDP neighbor address' }, 'targeted',
        { name: 'protocol', type: 'ENUM', optional: true, values: [{ keyword: 'ldp', description: 'Use LDP for the targeted session' }] }],
      description: 'Establish a targeted LDP session with a neighbor',
      undoDescription: 'Remove the targeted LDP session',
      modes: GLOBAL, minPrivilege: 15, undoOmitsArguments: false,
      run: (_session, args) => { host().ldp().addTargetedPeer(new IPAddress(String(args.address))); return ''; },
      undo: (_session, args) => { host().ldp().removeTargetedPeer(new IPAddress(String(args.address))); return ''; },
    },
    {
      id: 'mpls-ldp-discovery-targeted-hello-accept',
      path: ['mpls', 'ldp', 'discovery', 'targeted-hello', 'accept'],
      description: 'Accept targeted Hellos from any LSR',
      undoDescription: 'Stop accepting unsolicited targeted Hellos',
      modes: GLOBAL, minPrivilege: 15,
      run: () => { host().ldp().setAcceptTargetedHellos(true); return ''; },
      undo: () => { host().ldp().setAcceptTargetedHellos(false); return ''; },
    },
    {
      id: 'xconnect-mpls',
      path: ['xconnect', { name: 'peer', type: 'IP_ADDR', description: 'Peer router id' },
        { name: 'vcid', type: 'INT', range: [1, 4294967295], description: 'Pseudowire (VC) identifier' },
        'encapsulation', 'mpls'],
      description: 'Bind an attachment circuit to an MPLS pseudowire',
      undoDescription: 'Unbind the attachment circuit from the pseudowire',
      modes: INTERFACE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_session, args) => {
        for (const iface of host().selectedInterfaces()) {
          host().pseudowires().add({
            attachmentCircuit: iface, peer: new IPAddress(String(args.peer)), pwId: Number(args.vcid),
            controlWord: 'not-preferred', groupId: 0,
          });
        }
        return '';
      },
      undo: () => {
        for (const iface of host().selectedInterfaces()) host().pseudowires().remove(iface);
        return '';
      },
    },
    {
      id: 'ping-mpls-ipv4',
      path: ['ping', 'mpls', 'ipv4', { name: 'target', type: 'IP_PREFIX', description: 'Address prefix of the target to be tested (address/mask-length)' }],
      description: 'Check MPLS LSP connectivity',
      modes: PRIVILEGED, minPrivilege: 15,
      options: [
        { keyword: 'repeat', description: 'Number of times to resend the same packet', argument: { name: 'count', type: 'INT', range: [1, 2147483647], description: 'Repeat count' } },
        { keyword: 'size', description: 'Size of the packet with the label stack imposed', argument: { name: 'size', type: 'INT', range: [40, 18024], description: 'Packet size' } },
        { keyword: 'timeout', description: 'Timeout interval for an MPLS request packet', argument: { name: 'timeout', type: 'INT', range: [0, 3600], description: 'Seconds' } },
        { keyword: 'ttl', description: 'Time-to-live of the outermost label', argument: { name: 'ttl', type: 'INT', range: [1, 255], description: 'Time to live' } },
        { keyword: 'exp', description: 'MPLS experimental field value in the MPLS header', argument: { name: 'exp', type: 'INT', range: [0, 7], description: 'EXP bits' } },
        {
          keyword: 'reply', description: 'Reply options',
          choices: [
            { keyword: 'mode', description: 'Reply mode', argument: { name: 'mode', type: 'ENUM', description: 'Reply mode', values: [
              { keyword: 'ipv4', description: 'Reply with an IPv4 UDP packet' }, { keyword: 'router-alert', description: 'Reply with an IPv4 UDP packet with router alert' }] } },
            { keyword: 'dscp', description: 'DSCP of the echo reply', argument: { name: 'dscp', type: 'INT', range: [0, 63], description: 'DSCP value' } },
            { keyword: 'pad-tlv', description: 'Ask the replier to copy the pad TLV' },
          ],
        },
        { keyword: 'dsmap', description: 'Interrogate a transit router for downstream mapping information' },
        { keyword: 'verbose', description: 'Display the reply sender address and the return codes' },
      ],
      run: (_session, args) => runPingMpls(host(), args),
    },
    {
      id: 'traceroute-mpls-ipv4',
      path: ['traceroute', 'mpls', 'ipv4', { name: 'target', type: 'IP_PREFIX', description: 'Address prefix of the target to be tested (address/mask-length)' }],
      description: 'Discover MPLS LSP routes',
      modes: PRIVILEGED, minPrivilege: 15,
      options: [
        { keyword: 'timeout', description: 'Timeout interval for an MPLS request packet', argument: { name: 'timeout', type: 'INT', range: [0, 3600], description: 'Seconds' } },
        { keyword: 'ttl', description: 'Maximum time-to-live', argument: { name: 'ttl', type: 'INT', range: [1, 255], description: 'Maximum hop count' } },
        { keyword: 'exp', description: 'MPLS experimental field value in the MPLS header', argument: { name: 'exp', type: 'INT', range: [0, 7], description: 'EXP bits' } },
        {
          keyword: 'reply', description: 'Reply options',
          choices: [
            { keyword: 'mode', description: 'Reply mode', argument: { name: 'mode', type: 'ENUM', description: 'Reply mode', values: [
              { keyword: 'ipv4', description: 'Reply with an IPv4 UDP packet' }, { keyword: 'router-alert', description: 'Reply with an IPv4 UDP packet with router alert' }] } },
            { keyword: 'dscp', description: 'DSCP of the echo reply', argument: { name: 'dscp', type: 'INT', range: [0, 63], description: 'DSCP value' } },
            { keyword: 'pad-tlv', description: 'Ask the replier to copy the pad TLV' },
          ],
        },
      ],
      run: (_session, args) => runTraceMpls(host(), args),
    },
    {
      id: 'show-mpls-interfaces',
      path: ['show', 'mpls', 'interfaces', { name: 'iface', type: 'INTERFACE', optional: true, description: 'Interface to display' }],
      description: 'Interface label switching states',
      modes: SHOW, minPrivilege: 1,
      options: [{ keyword: 'detail', description: 'Display detailed label switching information' }],
      run: (_session, args) => {
        const wanted = args.iface === undefined ? null : host().resolveInterface(String(args.iface));
        if (args.iface !== undefined && wanted === null) return '% Invalid interface';
        const rows: MplsInterfaceRow[] = host().interfaceNames()
          .filter(name => host().ldp().isInterfaceEnabled(name) && (wanted === null || name === wanted))
          .map(name => ({ name, labelling: true, operational: host().interfaceIsUp(name) }));
        if (rows.length === 0) return '';
        if (args.detail === undefined) return formatMplsInterfaces(rows);
        return rows.map(row => [
          `Interface ${row.name}:`, '        IP labeling enabled (ldp)', '        LSP Tunnel labeling not enabled',
          row.operational ? '        MPLS operational' : '        MPLS not operational', `        MTU = ${host().interfaceMtu(row.name)}`,
        ].join('\n')).join('\n');
      },
    },
    {
      id: 'show-mpls-ldp-neighbor',
      path: ['show', 'mpls', 'ldp', 'neighbor',
        { name: 'selector', type: 'WORD', optional: true, description: 'Neighbor address, or interface over which neighbors are accessible' }],
      description: 'Show LDP neighbor information',
      modes: SHOW, minPrivilege: 1,
      options: [{ keyword: 'detail', description: 'Display information in long form' }],
      run: (_session, args) => {
        const detail = args.detail !== undefined || args.selector === 'detail';
        if (args.selector === undefined || args.selector === 'detail') return formatLdpNeighbors(mplsNeighborViews(host()), detail);
        const text = String(args.selector);
        if (/^\d+\.\d+\.\d+\.\d+$/.test(text)) return formatLdpNeighbors(mplsNeighborViews(host(), { address: text }), detail);
        const iface = host().resolveInterface(text);
        return iface === null ? "% Invalid input detected at '^' marker." : formatLdpNeighbors(mplsNeighborViews(host(), { iface }), detail);
      },
    },
    {
      id: 'show-mpls-ldp-bindings',
      path: ['show', 'mpls', 'ldp', 'bindings',
        { name: 'network', type: 'IP_ADDR', optional: true, description: 'Destination network number' },
        { name: 'mask', type: 'WORD', optional: true, description: 'Mask length (0-32) or dotted mask' }],
      description: 'Show the label information base',
      modes: SHOW, minPrivilege: 1,
      options: [
        { keyword: 'longer-prefixes', description: 'Select any prefix longer than the given one' },
        { keyword: 'local-label', description: 'Entries matching a local label', argument: { name: 'localLabel', type: 'INT', range: [0, 1048575], description: 'Label value' } },
        { keyword: 'remote-label', description: 'Entries matching a label assigned by a neighbor', argument: { name: 'remoteLabel', type: 'INT', range: [0, 1048575], description: 'Label value' } },
        { keyword: 'neighbor', description: 'Label bindings assigned by this neighbor', argument: { name: 'neighbor', type: 'IP_ADDR', description: 'LDP neighbor' } },
        { keyword: 'local', description: 'Local label bindings only' },
        { keyword: 'detail', description: 'Display where each local binding was advertised' },
      ],
      run: (_session, args) => {
        let length: number | undefined;
        if (args.network !== undefined) {
          if (args.mask === undefined) return '% Incomplete command.';
          length = maskLength(String(args.mask));
          if (length === null) return "% Invalid input detected at '^' marker.";
        }
        const views = mplsBindingViews(host(), {
          ...(args.network === undefined ? {} : { network: String(args.network), length, longerPrefixes: args['longer-prefixes'] !== undefined }),
          ...(args.localLabel === undefined ? {} : { localLabel: Number(args.localLabel) }),
          ...(args.remoteLabel === undefined ? {} : { remoteLabel: Number(args.remoteLabel) }),
          ...(args.neighbor === undefined ? {} : { neighbor: String(args.neighbor) }),
        });
        const localOnly = args.local !== undefined;
        return formatLdpBindings(localOnly ? views.map(view => ({ ...view, remote: [] })) : views, {
          detail: args.detail !== undefined, showLocal: args.neighbor === undefined,
        });
      },
    },
    {
      id: 'show-mpls-ldp-discovery',
      path: ['show', 'mpls', 'ldp', 'discovery'],
      description: 'Show LDP discovery information',
      modes: SHOW, minPrivilege: 1,
      options: [{ keyword: 'detail', description: 'Display detailed information about all LDP discovery sources' }],
      run: (_session, args) => {
        const engine = host().ldp();
        const adjacencies = engine.adjacencies();
        const interfaces = host().interfaceNames().filter(name => engine.isInterfaceEnabled(name)).map(iface => ({
          iface,
          peers: adjacencies.filter(a => a.iface === iface && !a.targeted).map(a => ({
            id: a.peer.toString(), source: a.source.toString(), transport: a.transport.toString(), holdSeconds: a.holdSeconds,
            proposedLocal: engine.config.helloHoldSeconds, proposedPeer: a.proposedHoldSeconds,
          })),
        }));
        const targeted = engine.targetedAddresses().map(address => {
          const adjacency = adjacencies.find(a => a.targeted && a.source.equals(address));
          return {
            localAddress: engine.localId.lsrId.toString(), remote: address.toString(), role: engine.targetedRole(address),
            peerId: adjacency?.peer.toString() ?? null, transport: adjacency?.transport.toString() ?? null,
            holdSeconds: adjacency?.holdSeconds ?? 0, proposedLocal: engine.config.targetedHelloHoldSeconds,
            proposedPeer: adjacency?.proposedHoldSeconds ?? 0,
          };
        });
        return formatLdpDiscovery({
          localId: engine.localId.toString(), helloIntervalMs: engine.config.helloIntervalSeconds * 1000,
          transportAddress: engine.localId.lsrId.toString(), interfaces, targeted,
          targetedIntervalMs: engine.config.targetedHelloIntervalSeconds * 1000,
        }, args.detail !== undefined);
      },
    },
    {
      id: 'show-mpls-ldp-parameters',
      path: ['show', 'mpls', 'ldp', 'parameters'],
      description: 'Show LDP parameters',
      modes: SHOW, minPrivilege: 1,
      run: () => {
        const config = host().ldp().config;
        const range = host().mpls().lfib.labelRange();
        const backoff = host().ldp().backoffParameters();
        return formatLdpParameters({
          labelMin: range.min, labelMax: range.max, sessionHoldSeconds: config.keepAliveSeconds,
          keepAliveSeconds: Math.floor(config.keepAliveSeconds / 3), helloHoldSeconds: config.helloHoldSeconds,
          helloIntervalSeconds: config.helloIntervalSeconds, targetedHoldSeconds: config.targetedHelloHoldSeconds,
          targetedIntervalSeconds: config.targetedHelloIntervalSeconds, backoffInitialSeconds: backoff.initialSeconds,
          backoffMaximumSeconds: backoff.maximumSeconds,
          loop: config.loopDetection ? { maxHops: config.maxHopCount, pathVectorLimit: config.pathVectorLimit } : null,
        });
      },
    },
    {
      id: 'show-mpls-ldp-capabilities',
      path: ['show', 'mpls', 'ldp', 'capabilities'],
      description: 'Show LDP capabilities',
      modes: SHOW, minPrivilege: 1,
      run: () => formatLdpCapabilities([]),
    },
    {
      id: 'show-mpls-ldp-backoff',
      path: ['show', 'mpls', 'ldp', 'backoff'],
      description: 'Show LDP session setup backoff',
      modes: SHOW, minPrivilege: 1,
      run: () => formatLdpBackoff(host().ldp().backoffParameters(), host().ldp().backoffEntries()),
    },
    {
      id: 'show-mpls-label-range',
      path: ['show', 'mpls', 'label', 'range'],
      description: 'Show the range of local labels',
      modes: SHOW, minPrivilege: 15,
      run: () => {
        const range = host().mpls().lfib.labelRange();
        return `Downstream label pool: Min/Max label: ${range.min}/${range.max}`;
      },
    },
    {
      id: 'show-mpls-forwarding-table',
      path: ['show', 'mpls', 'forwarding-table',
        { name: 'network', type: 'IP_ADDR', optional: true, description: 'Destination network number' },
        { name: 'mask', type: 'WORD', optional: true, description: 'Mask length (0-32) or dotted mask' }],
      description: 'Show the MPLS forwarding table',
      modes: SHOW, minPrivilege: 1,
      options: [
        { keyword: 'interface', description: 'Entries with this outgoing interface', argument: { name: 'iface', type: 'INTERFACE', description: 'Interface' } },
        { keyword: 'labels', description: 'Entries with this local label', argument: { name: 'label', type: 'INT', range: [0, 1048575], description: 'Local label' } },
        { keyword: 'next-hop', description: 'Entries with this neighbor as next hop', argument: { name: 'hop', type: 'IP_ADDR', description: 'Next hop' } },
        { keyword: 'vrf', description: 'Entries of this VRF', argument: { name: 'vrf', type: 'WORD', description: 'VRF name' } },
        { keyword: 'detail', description: 'Display information in long form' },
      ],
      run: (_session, args) => {
        let length: number | undefined;
        if (args.network !== undefined) {
          if (args.mask === undefined) return '% Incomplete command.';
          length = maskLength(String(args.mask));
          if (length === null) return "% Invalid input detected at '^' marker.";
        }
        const iface = args.iface === undefined ? undefined : host().resolveInterface(String(args.iface)) ?? undefined;
        if (args.iface !== undefined && iface === undefined) return '% Invalid interface';
        const detail = args.detail !== undefined;
        return formatMplsForwardingTable(mplsForwardingViews(host(), {
          ...(args.network === undefined ? {} : { network: String(args.network), length }),
          ...(iface === undefined ? {} : { iface }),
          ...(args.label === undefined ? {} : { label: Number(args.label) }),
          ...(args.hop === undefined ? {} : { nextHop: String(args.hop) }),
          ...(args.vrf === undefined ? {} : { vrf: String(args.vrf) }),
        }, detail), detail);
      },
    },
  ];
}

export function mplsGlobalRunningConfig(host: MplsShellHost): string[] {
  if (!host.present()) return [];
  const lines: string[] = [];
  if (!host.ldp().isGloballyEnabled()) lines.push('no mpls ip');
  const source = host.routerIdSourceText();
  if (source) lines.push(`mpls ldp router-id ${source}`);
  if (!host.mpls().propagateTtl) lines.push('no mpls ip propagate-ttl');
  if (host.ldp().config.acceptTargetedHellos) lines.push('mpls ldp discovery targeted-hello accept');
  for (const target of host.ldp().configuredTargets()) lines.push(`mpls ldp neighbor ${target} targeted ldp`);
  const config = host.ldp().config;
  const range = host.mpls().lfib.labelRange();
  if (range.min !== LABEL_RANGE_DEFAULT_MIN || range.max !== LABEL_RANGE_DEFAULT_MAX) lines.push(`mpls label range ${range.min} ${range.max}`);
  if (config.loopDetection) lines.push('mpls ldp loop-detection');
  if (config.maxHopCount !== DEFAULT_MAX_HOPS) lines.push(`mpls ldp maxhops ${config.maxHopCount}`);
  if (config.pathVectorExplicit) lines.push(`mpls ldp path-vector maxlength ${config.pathVectorLimit}`);
  if (config.keepAliveSeconds !== DEFAULT_SESSION_HOLD_SECONDS) lines.push(`mpls ldp holdtime ${config.keepAliveSeconds}`);
  if (config.targetedHelloHoldSeconds !== DEFAULT_TARGETED_HOLD_SECONDS) lines.push(`mpls ldp discovery targeted-hello holdtime ${config.targetedHelloHoldSeconds}`);
  if (config.targetedHelloIntervalSeconds !== DEFAULT_TARGETED_INTERVAL_SECONDS) lines.push(`mpls ldp discovery targeted-hello interval ${config.targetedHelloIntervalSeconds}`);
  if (config.backoffInitialSeconds !== DEFAULT_BACKOFF_INITIAL_SECONDS || config.backoffMaximumSeconds !== DEFAULT_BACKOFF_MAXIMUM_SECONDS) {
    lines.push(`mpls ldp backoff ${config.backoffInitialSeconds} ${config.backoffMaximumSeconds}`);
  }
  if (config.explicitNull) lines.push('mpls ldp explicit-null');
  if (config.helloHoldSeconds !== DEFAULT_HELLO_HOLD_SECONDS) lines.push(`mpls ldp discovery hello holdtime ${config.helloHoldSeconds}`);
  if (config.helloIntervalSeconds !== DEFAULT_HELLO_INTERVAL_SECONDS) lines.push(`mpls ldp discovery hello interval ${config.helloIntervalSeconds}`);
  return lines;
}

export function mplsInterfaceRunningConfig(host: MplsShellHost, iface: string): string[] {
  if (!host.present()) return [];
  const lines = host.ldp().isInterfaceEnabled(iface) ? [' mpls ip'] : [];
  for (const wire of host.pseudowires().configuration()) {
    if (wire.attachmentCircuit === iface) lines.push(` xconnect ${wire.peer} ${wire.pwId} encapsulation mpls`);
  }
  return lines;
}
