import type { IPv4Packet } from '../../core/types';
import type { CryptoMapEntry, IkeConfigReply, IkeConfigRequest, SATrafficSelector } from '../IPSecTypes';

export type ClientMode = 'client' | 'network-extension' | 'network-extension-plus';
export type ConnectMode = 'auto' | 'manual' | 'acl';
export type XauthMode = 'interactive' | 'local' | 'http-intercept';
export type ClientState = 'IDLE' | 'CONNECT_REQUIRED' | 'XAUTH_REQ' | 'IPSEC_ACTIVE';

export interface EzvpnPeer { readonly address: string; readonly primary: boolean }

export interface EzvpnClientConfig {
  readonly name: string;
  group?: string;
  key?: string;
  peers: EzvpnPeer[];
  mode: ClientMode;
  connect: ConnectMode;
  username?: string;
  password?: string;
  xauthMode?: XauthMode;
  acl?: string;
}

export interface EzvpnClientEngine {
  installManagedCryptoMap(mapName: string, entries: CryptoMapEntry[]): void;
  removeManagedCryptoMap(mapName: string): void;
  applyCryptoMapToInterface(iface: string, mapName: string): void;
  cryptoMapOn(iface: string): string | undefined;
  ensureEzvpnTransformSets(): string[];
  bringUpClientTunnel(peer: string, entry: CryptoMapEntry, iface: string): boolean;
  clearSAsForPeer(peer: string): void;
  requestConfigFor(peer: string, request: IkeConfigRequest): void;
  configReplyFor(peer: string): IkeConfigReply | undefined;
  hasIkeSA(peer: string): boolean;
  ikeFailureReason(peer: string): string | undefined;
}

export interface EzvpnClientHost {
  engine(): EzvpnClientEngine;
  interfaceAddress(iface: string): { address: string; mask: string } | null;
  aclSources(acl: string): readonly string[];
  resolve(host: string): string | null;
  createLoopback(address: string, mask: string): string;
  removeLoopback(name: string): void;
  nat: {
    setInside(iface: string): void;
    setOutside(iface: string): void;
    removeInside(iface: string): void;
    removeOutside(iface: string): void;
    addRule(aclId: string, outsideAddressInterface: string): void;
    removeRule(aclId: string): void;
  };
  log(line: string): void;
}

export interface ClientRuntime {
  state: ClientState;
  lastEvent: string;
  outside?: string;
  inside: Set<string>;
  peer?: string;
  reply?: IkeConfigReply;
  loopback?: string;
}

const MAP_PREFIX = '_ezvpn_';

function toNumber(address: string): number {
  return address.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function wildcardOf(mask: string): string {
  return mask.split('.').map((o) => 255 - Number(o)).join('.');
}

function inNetwork(address: string, network: string, mask: string): boolean {
  const m = toNumber(mask);
  return ((toNumber(address) & m) >>> 0) === ((toNumber(network) & m) >>> 0);
}

function networkOf(address: string, mask: string): string {
  const n = (toNumber(address) & toNumber(mask)) >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function parseCidrMask(entry: string): { network: string; mask: string } {
  const [network, mask] = entry.split('/');
  return { network, mask: mask ?? '255.255.255.255' };
}

export class EzvpnClient {
  readonly configs = new Map<string, EzvpnClientConfig>();
  private readonly runtimes = new Map<string, ClientRuntime>();
  private host: EzvpnClientHost | null = null;

  attach(host: EzvpnClientHost): void { this.host = host; }

  ensureConfig(name: string): EzvpnClientConfig {
    let config = this.configs.get(name);
    if (!config) {
      config = { name, peers: [], mode: 'client', connect: 'auto' };
      this.configs.set(name, config);
    }
    return config;
  }

  runtimeOf(name: string): ClientRuntime {
    let runtime = this.runtimes.get(name);
    if (!runtime) {
      runtime = { state: 'IDLE', lastEvent: 'RESET', inside: new Set() };
      this.runtimes.set(name, runtime);
    }
    return runtime;
  }

  isAssigned(name: string): boolean {
    const runtime = this.runtimes.get(name);
    return runtime !== undefined && (runtime.outside !== undefined || runtime.inside.size > 0);
  }

  assignOutside(name: string, iface: string): string | null {
    const runtime = this.runtimeOf(name);
    for (const [other, r] of this.runtimes) {
      if (other !== name && r.outside === iface) return `% Interface ${iface} already carries the Easy VPN configuration ${other}`;
    }
    const mapOn = this.host?.engine().cryptoMapOn(iface);
    if (mapOn && !mapOn.startsWith(MAP_PREFIX)) return `% Crypto map ${mapOn} is already applied to ${iface}`;
    runtime.outside = iface;
    this.start(name);
    return null;
  }

  assignInside(name: string, iface: string): void {
    const runtime = this.runtimeOf(name);
    runtime.inside.add(iface);
    if (runtime.outside) this.restart(name);
  }

  unassignOutside(name: string): void {
    const runtime = this.runtimeOf(name);
    this.teardown(name);
    runtime.outside = undefined;
    runtime.state = 'IDLE';
    runtime.lastEvent = 'REMOVE INTERFACE CFG';
  }

  unassignInside(name: string, iface: string): void {
    const runtime = this.runtimeOf(name);
    runtime.inside.delete(iface);
    if (runtime.outside) this.restart(name);
  }

  private restart(name: string): void {
    this.teardown(name);
    this.start(name);
  }

  start(name: string): void {
    const config = this.configs.get(name);
    const runtime = this.runtimeOf(name);
    if (!config || !runtime.outside) return;
    if (config.connect !== 'auto') {
      runtime.state = 'CONNECT_REQUIRED';
      runtime.lastEvent = 'MANUAL_CONNECT';
      return;
    }
    this.connect(name);
  }

  pendingTunnel(name?: string | null): { name: string } | { error: string } {
    const waiting = [...this.runtimes].filter(([n, r]) => r.state === 'XAUTH_REQ' && (!name || n === name)).map(([n]) => n);
    if (waiting.length === 0) return { error: name ? `% No pending extended authentication request for ${name}` : '% No pending extended authentication request' };
    if (waiting.length > 1) return { error: '% More than one tunnel is waiting: specify the tunnel name' };
    return { name: waiting[0] };
  }

  needsInteractiveXauth(config: EzvpnClientConfig): boolean {
    return (config.xauthMode ?? 'interactive') === 'interactive' && config.username === undefined;
  }

  connect(name: string, credentials?: { user: string; password: string }): string {
    const host = this.host;
    const config = this.configs.get(name);
    const runtime = this.runtimeOf(name);
    if (!host || !config) return `% Easy VPN configuration ${name} is not defined`;
    if (!runtime.outside) return `% Easy VPN configuration ${name} is not assigned to an interface`;
    if (!config.group || !config.key) return `% Easy VPN configuration ${name} has no group and key`;
    if (config.peers.length === 0) return `% Easy VPN configuration ${name} has no peer`;
    const user = credentials?.user ?? config.username;
    const password = credentials?.password ?? config.password;
    this.teardown(name);
    const attempts = [...config.peers].sort((a, b) => Number(b.primary) - Number(a.primary));
    for (const peer of attempts) {
      const address = host.resolve(peer.address);
      if (address === null) continue;
      const outcome = this.tryPeer(name, config, runtime, address, user, password);
      if (outcome === 'ok') return '';
      if (outcome === 'authentication' && user === undefined && (config.xauthMode ?? 'interactive') === 'interactive') {
        runtime.state = 'XAUTH_REQ';
        runtime.lastEvent = 'XAUTH_REQUIRED';
        runtime.peer = undefined;
        host.log('EZVPN: Pending XAuth Request, Please enter the following command:\nEZVPN: crypto ipsec client ezvpn xauth');
        return '';
      }
    }
    runtime.state = 'IDLE';
    runtime.lastEvent = 'SOCKET_DOWN';
    return '';
  }

  private tryPeer(
    name: string, config: EzvpnClientConfig, runtime: ClientRuntime, peer: string, user?: string, password?: string,
  ): 'ok' | 'authentication' | 'failed' {
    const host = this.host!;
    const engine = host.engine();
    const outside = runtime.outside!;
    const outsideInfo = host.interfaceAddress(outside);
    if (!outsideInfo) return 'failed';
    const insideNets = [...runtime.inside]
      .map((iface) => host.interfaceAddress(iface))
      .filter((info): info is { address: string; mask: string } => info !== null)
      .map((info) => ({ network: networkOf(info.address, info.mask), mask: info.mask }));
    const extra = config.mode === 'client' ? [] : (config.acl ? host.aclSources(config.acl).map(parseCidrMask) : []);
    const protectedNets = [...insideNets, ...extra];
    const mapName = `${MAP_PREFIX}${name}`;
    const transformSets = engine.ensureEzvpnTransformSets();
    const selectorOf = (src: { network: string; mask: string }): SATrafficSelector => ({
      srcAddress: src.network, srcWildcard: wildcardOf(src.mask), dstAddress: '', dstWildcard: '',
      protocol: 0, srcPort: 0, dstPort: 0,
    });
    const clientMode = config.mode === 'client';
    const splitOf = (): { network: string; mask: string }[] => (runtime.reply?.splitInclude ?? []).map(parseCidrMask);
    const entries: CryptoMapEntry[] = (clientMode ? [null] : protectedNets).map((net, index) => ({
      seq: 10 + index, type: 'ipsec-isakmp' as const, peers: [peer], transformSets, aclName: '',
      managedBy: 'ezvpn' as const, presharedKey: config.key, localIdentity: config.group,
      trafficSelectors: net ? selectorOf(net) : undefined,
      matcher: (packet: IPv4Packet) => {
        const source = packet.sourceIP.toString();
        const destination = packet.destinationIP.toString();
        if (destination === peer) return false;
        const split = splitOf();
        const toSplit = split.length === 0 || split.some((s) => inNetwork(destination, s.network, s.mask));
        if (clientMode) {
          const assigned = runtime.reply?.address;
          return assigned !== undefined && source === assigned && toSplit;
        }
        return net !== null && inNetwork(source, net.network, net.mask) && toSplit;
      },
    }));
    engine.installManagedCryptoMap(mapName, entries);
    engine.applyCryptoMapToInterface(outside, mapName);
    engine.requestConfigFor(peer, { wantAddress: true, identity: user, credential: password });
    const ok = entries.length > 0 && engine.bringUpClientTunnel(peer, entries[0], outside);
    const reply = engine.configReplyFor(peer);
    if (!ok || !engine.hasIkeSA(peer)) {
      const reason = engine.ikeFailureReason(peer);
      engine.removeManagedCryptoMap(mapName);
      engine.clearSAsForPeer(peer);
      return reason !== undefined && /AUTHENTICATION_FAILED/.test(reason) ? 'authentication' : 'failed';
    }
    runtime.peer = peer;
    runtime.reply = reply;
    if (reply) this.applyReply(name, config, runtime, reply, insideNets, entries, mapName, outside);
    runtime.state = 'IPSEC_ACTIVE';
    runtime.lastEvent = 'SOCKET_UP';
    return 'ok';
  }

  private applyReply(
    name: string, config: EzvpnClientConfig, runtime: ClientRuntime, reply: IkeConfigReply,
    insideNets: { network: string; mask: string }[], _entries: CryptoMapEntry[], _mapName: string, outside: string,
  ): void {
    const host = this.host!;
    if (config.mode === 'client') {
      runtime.loopback = host.createLoopback(reply.address, reply.netmask);
      const aclId = `ezvpn:${name}`;
      for (const iface of runtime.inside) host.nat.setInside(iface);
      host.nat.setOutside(outside);
      host.nat.addRule(aclId, runtime.loopback);
      void insideNets;
    } else if (config.mode === 'network-extension-plus') {
      runtime.loopback = host.createLoopback(reply.address, reply.netmask);
    }
  }

  natMatches(aclId: string, source: string, destination: string | undefined): boolean {
    const name = aclId.replace(/^ezvpn:/, '');
    const runtime = this.runtimes.get(name);
    const host = this.host;
    if (!runtime || !host || runtime.state !== 'IPSEC_ACTIVE') return false;
    const fromInside = [...runtime.inside].some((iface) => {
      const info = host.interfaceAddress(iface);
      return info !== null && inNetwork(source, info.address, info.mask);
    });
    if (!fromInside) return false;
    const split = (runtime.reply?.splitInclude ?? []).map(parseCidrMask);
    return split.length === 0 || (destination !== undefined && split.some((s) => inNetwork(destination, s.network, s.mask)));
  }

  teardown(name: string): void {
    const host = this.host;
    const runtime = this.runtimes.get(name);
    if (!host || !runtime) return;
    const engine = host.engine();
    if (runtime.peer) engine.clearSAsForPeer(runtime.peer);
    if (runtime.outside) {
      const mapName = `${MAP_PREFIX}${name}`;
      if (engine.cryptoMapOn(runtime.outside) === mapName) engine.removeManagedCryptoMap(mapName);
      host.nat.removeOutside(runtime.outside);
    }
    for (const iface of runtime.inside) host.nat.removeInside(iface);
    host.nat.removeRule(`ezvpn:${name}`);
    if (runtime.loopback) host.removeLoopback(runtime.loopback);
    runtime.loopback = undefined;
    runtime.peer = undefined;
    runtime.reply = undefined;
  }

  disconnect(name: string): void {
    const runtime = this.runtimeOf(name);
    this.teardown(name);
    runtime.state = this.configs.get(name)?.connect === 'auto' ? 'IDLE' : 'CONNECT_REQUIRED';
    runtime.lastEvent = 'MANUAL_DISCONNECT';
  }

  clear(name?: string): void {
    for (const [tunnel, runtime] of this.runtimes) {
      if (name !== undefined && tunnel !== name) continue;
      if (!runtime.outside) continue;
      this.teardown(tunnel);
      this.start(tunnel);
    }
  }

  removeConfig(name: string): string | null {
    if (this.isAssigned(name)) return 'Error: crypto map in use by interface; cannot delete';
    this.configs.delete(name);
    this.runtimes.delete(name);
    return null;
  }

  renderStatus(): string {
    const out: string[] = [];
    for (const [name, runtime] of this.runtimes) {
      const config = this.configs.get(name);
      if (!config) continue;
      if (runtime.state === 'IDLE' && !runtime.outside) {
        out.push(`Current State: IDLE`, `Last Event: ${runtime.lastEvent}`);
        continue;
      }
      out.push(`Tunnel name : ${name}`);
      out.push(`Inside interface list: ${[...runtime.inside].map((i) => `${i},`).join(' ')}`.trimEnd());
      out.push(`Outside interface: ${runtime.outside ?? ''}`);
      if (runtime.state === 'XAUTH_REQ') out.push('Pending XAuth Request');
      out.push(`Current State: ${runtime.state}`, `Last Event: ${runtime.lastEvent}`);
      const reply = runtime.reply;
      if (reply) {
        out.push(`Address: ${reply.address}`, `Mask: ${reply.netmask}`);
        if (reply.dnsServers?.[0]) out.push(`DNS Primary: ${reply.dnsServers[0]}`);
        if (reply.dnsServers?.[1]) out.push(`DNS Secondary: ${reply.dnsServers[1]}`);
        if (reply.winsServers?.[0]) out.push(`NBMS/WINS Primary: ${reply.winsServers[0]}`);
        if (reply.winsServers?.[1]) out.push(`NBMS/WINS Secondary: ${reply.winsServers[1]}`);
        if (reply.domain) out.push(`Default Domain: ${reply.domain}`);
        if (reply.splitInclude && reply.splitInclude.length > 0) {
          out.push(`Split Tunnel List: ${reply.splitInclude.length}`);
          for (const entry of reply.splitInclude) {
            const { network, mask } = parseCidrMask(entry);
            out.push(`\tAddress    : ${network}`, `\tMask       : ${mask}`, '\tProtocol   : 0x0', '\tSource Port: 0', '\tDest Port  : 0');
          }
        }
      }
      if (runtime.peer) out.push(`Current EzVPN Peer: ${runtime.peer}`);
    }
    return out.join('\n');
  }

  renderConfigLines(): string[] {
    const lines: string[] = [];
    for (const config of this.configs.values()) {
      lines.push(`crypto ipsec client ezvpn ${config.name}`);
      if (config.connect !== 'auto') lines.push(` connect ${config.connect}`);
      if (config.group && config.key) lines.push(` group ${config.group} key ${config.key}`);
      if (config.mode !== 'client') lines.push(` mode ${config.mode === 'network-extension' ? 'network-extension' : 'network extension plus'}`);
      for (const peer of config.peers) lines.push(` peer ${peer.address}${peer.primary ? ' default' : ''}`);
      if (config.acl) lines.push(` acl ${config.acl}`);
      if (config.username !== undefined) lines.push(` username ${config.username} password 0 ${config.password ?? ''}`);
      if (config.xauthMode && config.xauthMode !== 'interactive') lines.push(` xauth userid mode ${config.xauthMode}`);
    }
    return lines;
  }

  interfaceLines(iface: string): string[] {
    const lines: string[] = [];
    for (const [name, runtime] of this.runtimes) {
      if (runtime.outside === iface) lines.push(` crypto ipsec client ezvpn ${name}`);
      if (runtime.inside.has(iface)) lines.push(` crypto ipsec client ezvpn ${name} inside`);
    }
    return lines;
  }
}
