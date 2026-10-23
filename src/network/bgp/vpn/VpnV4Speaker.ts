import { IPAddress, SubnetMask } from '@/network/core/types';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import type { VrfRoute } from '@/network/vrf/VrfForwarding';
import { compareBgpPaths, BGP_DEFAULT_LOCAL_PREF, BGP_WEIGHT_LOCAL, type BgpPathCandidate } from '../bestPath';
import {
  AFI_IPV4, SAFI_MPLS_VPN, type BgpUpdateMessage, type BgpVpnv4Attributes, type BgpVpnv4Nlri,
  type BgpVpnv4Withdrawal,
} from '../messages';

export type VpnExportSource = 'connected' | 'static';

export interface VpnLocalRoute {
  readonly network: IPAddress;
  readonly prefixLength: number;
  readonly source: VpnExportSource;
}

export interface VpnVrfConfig {
  readonly name: string;
  readonly rd: string | null;
  readonly importRts: readonly string[];
  readonly exportRts: readonly string[];
  readonly redistribute: ReadonlySet<VpnExportSource>;
  readonly localRoutes: readonly VpnLocalRoute[];
}

export interface VpnPeer {
  readonly ip: string;
  readonly remoteAsn: number;
  readonly remoteRouterId: string;
  readonly localIp: string;
  send(update: BgpUpdateMessage): void;
}

export interface VpnV4Host {
  localAsn(): number;
  localRouterId(): string;
  vrfs(): readonly VpnVrfConfig[];
  vpnPeers(): readonly VpnPeer[];
  installImported(vrf: string, routes: VrfRoute[]): void;
  allocateLabel(vrf: string): MplsLabel;
  releaseLabel(label: MplsLabel): void;
}

export interface VpnPath {
  readonly key: string;
  readonly rd: string;
  readonly network: IPAddress;
  readonly prefixLength: number;
  readonly label: MplsLabel;
  readonly nextHop: string;
  readonly origin: BgpVpnv4Attributes['origin'];
  readonly asPath: readonly number[];
  readonly localPref: number;
  readonly med: number;
  readonly routeTargets: readonly string[];
  readonly source: 'local' | 'ebgp' | 'ibgp';
  readonly peerIp: string;
  readonly peerRouterId: string;
  readonly vrf: string | null;
}

const EBGP_DISTANCE = 20;
const IBGP_DISTANCE = 200;
const ROUTE_TARGET_PREFIX = 'RT:';

function pathKey(rd: string, network: IPAddress, prefixLength: number): string {
  return `${rd}|${network}/${prefixLength}`;
}

function candidateOf(path: VpnPath): BgpPathCandidate {
  return {
    route: { network: path.network, mask: SubnetMask.fromCIDR(path.prefixLength), nextHop: null, iface: '', protocol: 'bgp', adminDistance: 0, metric: 0 },
    weight: path.source === 'local' ? BGP_WEIGHT_LOCAL : 0,
    localPref: path.localPref,
    locallyOriginated: path.source === 'local',
    asPath: path.asPath,
    origin: path.origin,
    med: path.med,
    isEbgp: path.source === 'ebgp',
    peerRouterId: path.peerRouterId,
    peerIp: path.peerIp,
  };
}

function serialOf(path: VpnPath, nextHop: string, asPath: readonly number[]): string {
  return `${path.label.value}|${nextHop}|${asPath.join(',')}|${path.localPref}|${path.med}|${[...path.routeTargets].sort().join(',')}`;
}

export class VpnV4Speaker {
  private readonly local = new Map<string, VpnPath>();
  private readonly received = new Map<string, Map<string, VpnPath>>();
  private readonly advertised = new Map<string, Map<string, string>>();
  private syncing = false;
  private version = 0;

  constructor(private readonly host: VpnV4Host) {}

  peerUp(peerIp: string): void {
    this.received.set(peerIp, new Map());
    this.advertised.set(peerIp, new Map());
    this.sync();
  }

  peerDown(peerIp: string): void {
    this.received.delete(peerIp);
    this.advertised.delete(peerIp);
    this.version++;
    this.sync();
  }

  tableVersion(): number {
    return this.version;
  }

  receivedCount(peerIp: string): number {
    return this.received.get(peerIp)?.size ?? 0;
  }

  paths(): readonly VpnPath[] {
    return [...this.local.values(), ...[...this.received.values()].flatMap(table => [...table.values()])];
  }

  onUpdate(peer: VpnPeer, update: BgpUpdateMessage): void {
    const table = this.received.get(peer.ip);
    if (!table) return;
    this.version++;
    for (const withdrawal of update.mpUnreach?.safi === SAFI_MPLS_VPN ? update.mpUnreach.nlri : []) {
      table.delete(pathKey(withdrawal.rd, new IPAddress(withdrawal.network), withdrawal.prefixLength));
    }
    const reach = update.mpReach;
    if (reach && reach.afi === AFI_IPV4 && reach.safi === SAFI_MPLS_VPN && !reach.attributes.asPath.includes(this.host.localAsn())) {
      const source = peer.remoteAsn === this.host.localAsn() ? 'ibgp' : 'ebgp';
      for (const nlri of reach.nlri) {
        const network = new IPAddress(nlri.network);
        const key = pathKey(nlri.rd, network, nlri.prefixLength);
        table.set(key, {
          key, rd: nlri.rd, network, prefixLength: nlri.prefixLength, label: MplsLabel.of(nlri.label), nextHop: reach.nextHop,
          origin: reach.attributes.origin, asPath: [...reach.attributes.asPath], localPref: reach.attributes.localPref ?? BGP_DEFAULT_LOCAL_PREF,
          med: reach.attributes.med ?? 0,
          routeTargets: reach.attributes.extendedCommunities.filter(c => c.startsWith(ROUTE_TARGET_PREFIX)).map(c => c.slice(ROUTE_TARGET_PREFIX.length)),
          source, peerIp: peer.ip, peerRouterId: peer.remoteRouterId, vrf: null,
        });
      }
    }
    this.sync();
  }

  sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    try {
      this.refreshLocal();
      this.advertise();
      this.importIntoVrfs();
    } finally {
      this.syncing = false;
    }
  }

  private refreshLocal(): void {
    const fresh = new Map<string, VpnPath>();
    for (const vrf of this.host.vrfs()) {
      if (vrf.rd === null || vrf.exportRts.length === 0) continue;
      for (const route of vrf.localRoutes) {
        if (!vrf.redistribute.has(route.source)) continue;
        const key = pathKey(vrf.rd, route.network, route.prefixLength);
        const existing = this.local.get(key);
        fresh.set(key, existing && existing.vrf === vrf.name ? { ...existing, routeTargets: [...vrf.exportRts] } : {
          key, rd: vrf.rd, network: route.network, prefixLength: route.prefixLength, label: this.host.allocateLabel(vrf.name),
          nextHop: this.host.localRouterId(), origin: 'incomplete', asPath: [], localPref: BGP_DEFAULT_LOCAL_PREF, med: 0,
          routeTargets: [...vrf.exportRts], source: 'local', peerIp: '0.0.0.0', peerRouterId: this.host.localRouterId(), vrf: vrf.name,
        });
      }
    }
    const changed = fresh.size !== this.local.size || [...fresh.keys()].some(key => !this.local.has(key));
    if (changed) this.version++;
    for (const [key, path] of this.local) if (!fresh.has(key)) this.host.releaseLabel(path.label);
    this.local.clear();
    for (const [key, path] of fresh) this.local.set(key, path);
  }

  bestPaths(): Map<string, VpnPath> {
    const best = new Map<string, VpnPath>();
    const consider = (path: VpnPath): void => {
      const held = best.get(path.key);
      if (!held || compareBgpPaths(candidateOf(path), candidateOf(held)) < 0) best.set(path.key, path);
    };
    for (const path of this.local.values()) consider(path);
    for (const table of this.received.values()) for (const path of table.values()) consider(path);
    return best;
  }

  private advertise(): void {
    const best = this.bestPaths();
    for (const peer of this.host.vpnPeers()) {
      const sent = this.advertised.get(peer.ip);
      if (!sent) continue;
      const ibgp = peer.remoteAsn === this.host.localAsn();
      const groups = new Map<string, { attributes: BgpVpnv4Attributes; nlri: BgpVpnv4Nlri[] }>();
      const desired = new Map<string, string>();
      for (const path of best.values()) {
        if (path.peerIp === peer.ip) continue;
        if (ibgp && path.source === 'ibgp') continue;
        const asPath = ibgp ? path.asPath : [this.host.localAsn(), ...path.asPath];
        const serial = serialOf(path, peer.localIp, asPath);
        desired.set(path.key, serial);
        if (sent.get(path.key) === serial) continue;
        const attributes: BgpVpnv4Attributes = {
          origin: path.origin, asPath, ...(ibgp ? { localPref: path.localPref } : {}), med: path.med,
          extendedCommunities: path.routeTargets.map(rt => `${ROUTE_TARGET_PREFIX}${rt}`),
        };
        const groupKey = JSON.stringify(attributes);
        const group = groups.get(groupKey) ?? { attributes, nlri: [] };
        group.nlri.push({ rd: path.rd, network: String(path.network), prefixLength: path.prefixLength, label: path.label.value });
        groups.set(groupKey, group);
      }
      const withdrawn: BgpVpnv4Withdrawal[] = [];
      for (const key of [...sent.keys()]) {
        if (desired.has(key)) continue;
        sent.delete(key);
        const [rd, prefix] = key.split('|');
        const [network, length] = prefix.split('/');
        withdrawn.push({ rd, network, prefixLength: Number(length) });
      }
      for (const [key, serial] of desired) sent.set(key, serial);
      if (withdrawn.length > 0) {
        peer.send({ type: 'bgp', message: 'update', withdrawn: [], announced: [], mpUnreach: { afi: AFI_IPV4, safi: SAFI_MPLS_VPN, nlri: withdrawn } });
      }
      for (const group of groups.values()) {
        peer.send({
          type: 'bgp', message: 'update', withdrawn: [], announced: [],
          mpReach: { afi: AFI_IPV4, safi: SAFI_MPLS_VPN, nextHop: peer.localIp, nlri: group.nlri, attributes: group.attributes },
        });
      }
    }
  }

  private importIntoVrfs(): void {
    const best = this.bestPaths();
    for (const vrf of this.host.vrfs()) {
      const imported: VrfRoute[] = [];
      if (vrf.rd !== null && vrf.importRts.length > 0) {
        for (const path of best.values()) {
          if (path.source === 'local') continue;
          if (!path.routeTargets.some(rt => vrf.importRts.includes(rt))) continue;
          imported.push({
            network: path.network, mask: SubnetMask.fromCIDR(path.prefixLength), nextHop: null, iface: '', type: 'bgp',
            ad: path.source === 'ebgp' ? EBGP_DISTANCE : IBGP_DISTANCE, metric: path.med,
            vpn: { label: path.label, bgpNextHop: new IPAddress(path.nextHop) },
          });
        }
      }
      this.host.installImported(vrf.name, imported);
    }
  }
}
