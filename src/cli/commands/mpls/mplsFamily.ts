import type { CommandSpec } from '@/cli/CommandTable';
import type { LdpEngine } from '@/network/ldp/LdpEngine';
import type { MplsEngine } from '@/network/mpls/MplsEngine';
import { IPAddress } from '@/network/core/types';
import type { PseudowireEngine } from '@/network/pw/PseudowireEngine';
import {
  formatLdpBindings, formatLdpDiscovery, formatLdpNeighbors, formatMplsForwardingTable, formatMplsInterfaces,
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
}

const GLOBAL = Object.freeze(['config']);
const INTERFACE = Object.freeze(['config-if', 'config-subif']);
const GLOBAL_OR_INTERFACE = Object.freeze(['config', 'config-if', 'config-subif']);
const SHOW = Object.freeze(['user', 'privileged']);
const DEFAULT_HELLO_INTERVAL_SECONDS = 5;
const DEFAULT_HELLO_HOLD_SECONDS = 15;

export function mplsNeighborViews(host: MplsShellHost): LdpNeighborView[] {
  const engine = host.ldp();
  const config = engine.config;
  return engine.sessions().filter(session => session.state === 'operational' && session.peer).map(session => {
    const peer = session.peer!;
    const sources = engine.adjacencies().filter(a => a.peer.equals(peer)).map(a => ({
      iface: a.iface, source: a.source.toString(),
      holdMs: a.holdSeconds * 1000, intervalMs: config.helloIntervalSeconds * 1000,
    }));
    return {
      peerId: peer.toString(), localId: engine.localId.toString(),
      remoteTransport: session.socket.remoteIp, remotePort: session.socket.remotePort,
      localTransport: session.socket.localIp, localPort: session.socket.localPort,
      state: 'Oper', messagesSent: session.messagesSent, messagesReceived: session.messagesReceived,
      upMs: session.operationalSinceMs === null ? 0 : Math.max(0, engine.nowMs() - session.operationalSinceMs),
      sources, addresses: [...session.peerAddresses.keys()].sort(addressOrder),
    };
  });
}

function addressOrder(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export function mplsBindingViews(host: MplsShellHost): LdpBindingView[] {
  const engine = host.ldp();
  const peers = engine.sessions().filter(session => session.state === 'operational' && session.peer);
  return engine.bindings().map(binding => ({
    prefix: binding.fec.prefix.toString(), length: binding.fec.length, revision: binding.revision, local: binding.label,
    remote: peers.flatMap(session => {
      const label = engine.remoteBindings(session.peer!).get(binding.fec.key);
      return label ? [{ peerId: session.peer!.toString(), label }] : [];
    }),
  })).sort((a, b) => addressOrder(a.prefix, b.prefix) || a.length - b.length);
}

export function mplsForwardingViews(host: MplsShellHost): MplsForwardingView[] {
  const mpls = host.mpls();
  return host.ldp().forwardingRows().map(row => ({
    localLabel: row.localLabel, outgoing: row.outgoing, prefix: `${row.fec.prefix}/${row.fec.length}`,
    bytes: mpls.bytesSwitched(row.localLabel), iface: row.iface, nextHop: row.nextHop,
  })).sort((a, b) => a.localLabel.value - b.localLabel.value);
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
      id: 'show-mpls-interfaces',
      path: ['show', 'mpls', 'interfaces'],
      description: 'Interface label switching states',
      modes: SHOW, minPrivilege: 1,
      run: () => {
        const rows: MplsInterfaceRow[] = host().interfaceNames().filter(name => host().ldp().isInterfaceEnabled(name))
          .map(name => ({ name, labelling: true, operational: host().interfaceIsUp(name) }));
        return rows.length === 0 ? '' : formatMplsInterfaces(rows);
      },
    },
    {
      id: 'show-mpls-ldp-neighbor',
      path: ['show', 'mpls', 'ldp', 'neighbor'],
      description: 'Show LDP neighbor information',
      modes: SHOW, minPrivilege: 1,
      run: () => formatLdpNeighbors(mplsNeighborViews(host())),
    },
    {
      id: 'show-mpls-ldp-bindings',
      path: ['show', 'mpls', 'ldp', 'bindings'],
      description: 'Show the label information base',
      modes: SHOW, minPrivilege: 1,
      run: () => formatLdpBindings(mplsBindingViews(host())),
    },
    {
      id: 'show-mpls-ldp-discovery',
      path: ['show', 'mpls', 'ldp', 'discovery'],
      description: 'Show LDP discovery information',
      modes: SHOW, minPrivilege: 1,
      run: () => {
        const engine = host().ldp();
        const interfaces = host().interfaceNames().filter(name => engine.isInterfaceEnabled(name)).map(iface => ({
          iface, peers: engine.adjacencies().filter(a => a.iface === iface).map(a => a.peer.toString()),
        }));
        return formatLdpDiscovery({ localId: engine.localId.toString(), interfaces });
      },
    },
    {
      id: 'show-mpls-forwarding-table',
      path: ['show', 'mpls', 'forwarding-table'],
      description: 'Show the MPLS forwarding table',
      modes: SHOW, minPrivilege: 1,
      run: () => formatMplsForwardingTable(mplsForwardingViews(host())),
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
