import { IPAddress, MACAddress, ethernetFrameBytesWithoutFcs, type EthernetFrame } from '@/network/core/types';
import { BridgeFdb } from '@/network/devices/firewall/l2/BridgeFdb';
import type { LdpEngine, LdpPwHandler } from '@/network/ldp/LdpEngine';
import type { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import type { GeneralizedPwFec, PwFec } from '@/network/ldp/LdpMessages';
import type { MplsEngine } from '@/network/mpls/MplsEngine';
import type { MplsLabel } from '@/network/mpls/MplsLabel';
import type { BGPEngine } from '@/network/bgp/BGPEngine';
import { VPLS_ENCAPSULATION_TYPE, type VplsLocalInstance, type VplsRemoteAdvertisement } from '@/network/bgp/vpls/VplsBgpSpeaker';
import type { BgpVplsNlri } from '@/network/bgp/messages';
import { BgpPseudowire, type BgpLocalBlock } from './BgpPseudowire';
import { controlWordOf, isValidControlWord, type PseudowirePayload } from './PseudowirePacket';
import { PW_TYPE_ETHERNET_RAW, type PseudowireHost } from './PseudowireEngine';
import { PseudowireSession, mtuOf, mtuParameter, type ControlWordPreference, type RemoteMapping } from './PseudowireSession';

export const VPLS_AGI_TYPE = 1;
const ETHERNET_HEADER_BYTES = 14;
const NULL_IDENTIFIER = Object.freeze({ type: 0, value: new Uint8Array(0) });

export interface VplsConfig {
  readonly name: string;
  readonly vpnId: number;
  readonly controlWord: ControlWordPreference;
}

export interface VplsNeighborView {
  readonly peer: IPAddress;
  readonly state: 'up' | 'down';
  readonly reason: string | null;
  readonly localLabel: MplsLabel | null;
  readonly remoteLabel: MplsLabel | null;
}

export interface VplsCounters {
  flooded: number;
  forwarded: number;
  droppedSplitHorizon: number;
  droppedDown: number;
  droppedMtu: number;
  droppedControlWord: number;
  macWithdrawsSent: number;
  macWithdrawsReceived: number;
}

export interface VplsPseudowire {
  readonly localLabel: MplsLabel | null;
  readonly remote: { readonly label: MplsLabel } | null;
  readonly sendsControlWord: boolean;
  readonly receivesControlWord: boolean;
  blocker(): string | null;
  teardown(): void;
}

export interface VplsBgpConfig extends VplsConfig {
  readonly rd: string;
  readonly routeTarget: string;
  readonly veId: number;
  readonly veBlockSize: number;
}

interface Neighbor {
  readonly peer: IPAddress;
  readonly session: VplsPseudowire;
  readonly ldp?: PseudowireSession;
  readonly veId?: number;
}

interface BgpState {
  readonly config: VplsBgpConfig;
  readonly block: BgpLocalBlock;
}

interface Instance {
  config: VplsConfig;
  readonly attachmentCircuits: Set<string>;
  readonly neighbors: Map<string, Neighbor>;
  readonly fdb: BridgeFdb;
  bgp?: BgpState;
}

function agiBytes(vpnId: number): Uint8Array {
  return Uint8Array.of((vpnId >>> 24) & 0xff, (vpnId >>> 16) & 0xff, (vpnId >>> 8) & 0xff, vpnId & 0xff);
}

function agiValue(bytes: Uint8Array): number | null {
  return bytes.length === 4 ? ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0 : null;
}

function attachmentPort(iface: string): string {
  return `ac:${iface}`;
}

function pseudowirePort(peer: IPAddress): string {
  return `pw:${peer}`;
}

function floods(destination: MACAddress): boolean {
  return destination.isGroup();
}

export class VplsEngine implements LdpPwHandler {
  readonly counters: VplsCounters = {
    flooded: 0, forwarded: 0, droppedSplitHorizon: 0, droppedDown: 0, droppedMtu: 0, droppedControlWord: 0,
    macWithdrawsSent: 0, macWithdrawsReceived: 0,
  };
  private readonly instances = new Map<string, Instance>();
  private readonly pendingRemote = new Map<string, RemoteMapping>();
  private bgp: BGPEngine | null = null;

  constructor(
    private readonly host: PseudowireHost,
    private readonly ldp: () => LdpEngine,
    private readonly mpls: () => MplsEngine,
  ) {}

  define(config: VplsConfig): void {
    if (this.instances.has(config.name)) throw new Error(`VPLS ${config.name} already defined`);
    this.instances.set(config.name, {
      config, attachmentCircuits: new Set(), neighbors: new Map(), fdb: new BridgeFdb({ now: () => this.ldp().nowMs() }),
    });
    this.ldp().addPwHandler(this);
  }

  defineBgp(config: VplsBgpConfig): void {
    this.define(config);
    const instance = this.instance(config.name);
    const veBlockOffset = 1;
    const base = this.mpls().lfib.allocateLabelBlock(config.veBlockSize, offset => ({
      kind: 'pw', owner: 'vpls', endpoint: `${config.name}|ve:${veBlockOffset + offset}`,
    }));
    instance.bgp = {
      config,
      block: {
        veId: config.veId, offset: veBlockOffset, size: config.veBlockSize, base,
        controlWord: config.controlWord === 'preferred', mtu: () => this.mtuOf(instance),
      },
    };
    this.bgp?.vplsBgpSpeaker()?.sync();
  }

  attachBgp(bgp: BGPEngine): void {
    this.bgp = bgp;
    bgp.setVplsHost({
      instances: () => this.localBgpInstances(),
      remoteAdvertised: advertisement => this.bgpAdvertised(advertisement),
      remoteWithdrawn: (name, _peerIp, nlri) => this.bgpWithdrawn(name, nlri),
    });
  }

  addAttachmentCircuit(name: string, iface: string): void {
    this.instance(name).attachmentCircuits.add(iface);
  }

  removeAttachmentCircuit(name: string, iface: string): void {
    const instance = this.instance(name);
    if (!instance.attachmentCircuits.delete(iface)) return;
    instance.fdb.forgetPort(attachmentPort(iface));
  }

  addNeighbor(name: string, peer: IPAddress): void {
    const instance = this.instance(name);
    if (instance.neighbors.has(peer.toString())) return;
    const session = new PseudowireSession({
      peer, controlWord: instance.config.controlWord,
      ilmEntry: { kind: 'pw', owner: 'vpls', endpoint: `${name}|${peer}` },
      fec: (controlWord, withParameters) => this.fecOf(instance, controlWord, withParameters),
      matches: fec => fec.kind === 'gen-pwid' && fec.pwType === PW_TYPE_ETHERNET_RAW
        && agiValue(fec.agi.value) === instance.config.vpnId,
      mtu: () => this.mtuOf(instance),
      localUp: () => true,
    }, this.ldp, this.mpls);
    instance.neighbors.set(peer.toString(), { peer, session, ldp: session });
    const held = this.pendingRemote.get(`${instance.config.vpnId}|${peer}`);
    if (held !== undefined) {
      session.adopt(held);
      this.pendingRemote.delete(`${instance.config.vpnId}|${peer}`);
    }
    this.ldp().addTargetedPeer(peer);
    if (instance.config.vpnId > 0) session.advertise();
  }

  undefine(name: string): void {
    const instance = this.instances.get(name);
    if (instance === undefined) return;
    for (const neighbor of [...instance.neighbors.values()]) this.removeNeighbor(name, neighbor.peer);
    this.instances.delete(name);
  }

  views(): ReadonlyArray<{
    readonly name: string; readonly vpnId: number; readonly state: 'up' | 'down';
    readonly attachmentCircuits: readonly string[]; readonly neighbors: readonly VplsNeighborView[];
  }> {
    return [...this.instances.values()].map(instance => {
      const neighbors = this.neighborViews(instance.config.name);
      return {
        name: instance.config.name, vpnId: instance.config.vpnId,
        state: neighbors.some(neighbor => neighbor.state === 'up') ? 'up' as const : 'down' as const,
        attachmentCircuits: [...instance.attachmentCircuits], neighbors,
      };
    });
  }

  setVpnId(name: string, vpnId: number): void {
    const instance = this.instance(name);
    if (instance.config.vpnId === vpnId) return;
    for (const neighbor of instance.neighbors.values()) neighbor.ldp?.teardown();
    instance.config = { ...instance.config, vpnId };
    if (vpnId > 0) for (const neighbor of instance.neighbors.values()) neighbor.ldp?.advertise();
  }

  removeNeighbor(name: string, peer: IPAddress): void {
    const instance = this.instance(name);
    const neighbor = instance.neighbors.get(peer.toString());
    if (neighbor === undefined) return;
    instance.neighbors.delete(peer.toString());
    neighbor.session.teardown();
    instance.fdb.forgetPort(pseudowirePort(peer));
    const shared = [...this.instances.values()].some(other => other.neighbors.has(peer.toString()));
    if (!shared) this.ldp().removeTargetedPeer(peer);
  }

  neighborViews(name: string): readonly VplsNeighborView[] {
    return [...this.instance(name).neighbors.values()].map(({ peer, session }) => ({
      peer, state: session.blocker() === null ? 'up' : 'down', reason: session.blocker(),
      localLabel: session.localLabel, remoteLabel: session.remote?.label ?? null,
    }));
  }

  macTable(name: string): readonly { readonly mac: string; readonly port: string }[] {
    return this.instance(name).fdb.entries().map(entry => ({ mac: entry.mac, port: entry.port }));
  }

  configuration(): readonly (VplsConfig & { readonly attachmentCircuits: readonly string[]; readonly neighbors: readonly IPAddress[] })[] {
    return [...this.instances.values()].map(instance => ({
      ...instance.config, attachmentCircuits: [...instance.attachmentCircuits], neighbors: [...instance.neighbors.values()].map(n => n.peer),
    }));
  }

  attaches(iface: string): boolean {
    return this.owner(iface) !== undefined;
  }

  ingress(iface: string, frame: EthernetFrame): void {
    const instance = this.owner(iface);
    if (instance === undefined) return;
    const source = attachmentPort(iface);
    instance.fdb.learn(frame.srcMAC.toString(), source);
    const destination = frame.dstMAC;
    const known = floods(destination) ? undefined : instance.fdb.lookup(destination.toString());
    if (known === undefined) {
      this.flood(instance, frame, source, true);
      return;
    }
    if (known === source) return;
    this.deliverTo(instance, known, frame);
  }

  egress(inPort: string, endpoint: string, payload: PseudowirePayload): void {
    void inPort;
    const [name, peerText] = endpoint.split('|');
    const instance = this.instances.get(name);
    const neighbor = peerText.startsWith('ve:')
      ? [...(instance?.neighbors.values() ?? [])].find(n => n.veId === Number(peerText.slice(3)))
      : instance?.neighbors.get(peerText);
    if (instance === undefined || neighbor === undefined || neighbor.session.blocker() !== null) {
      this.counters.droppedDown++;
      return;
    }
    if (neighbor.session.receivesControlWord !== (payload.controlWord !== null)
      || (payload.controlWord !== null && !isValidControlWord(payload.controlWord))) {
      this.counters.droppedControlWord++;
      return;
    }
    if (ethernetFrameBytesWithoutFcs(payload.frame) - ETHERNET_HEADER_BYTES > this.mtuOf(instance)) {
      this.counters.droppedMtu++;
      return;
    }
    const source = pseudowirePort(neighbor.peer);
    instance.fdb.learn(payload.frame.srcMAC.toString(), source);
    const known = floods(payload.frame.dstMAC) ? undefined : instance.fdb.lookup(payload.frame.dstMAC.toString());
    if (known === undefined) {
      this.flood(instance, payload.frame, source, false);
      return;
    }
    if (known.startsWith('pw:')) {
      this.counters.droppedSplitHorizon++;
      return;
    }
    this.deliverTo(instance, known, payload.frame);
  }

  attachmentStateChanged(iface: string): void {
    const instance = this.owner(iface);
    if (instance === undefined) return;
    instance.fdb.forgetPort(attachmentPort(iface));
    for (const neighbor of instance.neighbors.values()) {
      if (neighbor.ldp === undefined || neighbor.session.blocker() !== null) continue;
      const sent = this.ldp().sendToPeer(neighbor.peer, [{
        kind: 'mac-withdraw', id: this.ldp().nextMessageId(), fec: [this.fecOf(instance, false, false)], macs: [],
      }]);
      if (sent) this.counters.macWithdrawsSent++;
    }
  }

  sessionOperational(peer: LdpIdentifier): void {
    for (const instance of this.instances.values()) {
      if (instance.config.vpnId > 0) instance.neighbors.get(peer.lsrId.toString())?.ldp?.advertise();
    }
  }

  sessionClosed(peer: LdpIdentifier): void {
    for (const instance of this.instances.values()) {
      instance.neighbors.get(peer.lsrId.toString())?.ldp?.sessionClosed();
      instance.fdb.forgetPort(pseudowirePort(peer.lsrId));
    }
  }

  mapping(peer: LdpIdentifier, fec: PwFec, label: MplsLabel, pwStatus: number | undefined): void {
    if (fec.kind !== 'gen-pwid') return;
    const vpnId = agiValue(fec.agi.value);
    if (vpnId === null || fec.agi.type !== VPLS_AGI_TYPE) return;
    const neighbor = this.neighborFor(peer, fec);
    if (neighbor === undefined) {
      this.pendingRemote.set(`${vpnId}|${peer.lsrId}`, {
        label, controlWord: fec.controlWord, mtu: mtuOf(fec), statusTlv: pwStatus !== undefined, status: pwStatus ?? 0,
      });
      return;
    }
    neighbor.ldp?.mapping(peer, fec, label, pwStatus);
  }

  withdraw(peer: LdpIdentifier, fec: PwFec, label: MplsLabel | undefined, status: number | undefined): void {
    if (fec.kind !== 'gen-pwid') return;
    const vpnId = agiValue(fec.agi.value);
    if (vpnId !== null) this.pendingRemote.delete(`${vpnId}|${peer.lsrId}`);
    this.neighborFor(peer, fec)?.ldp?.withdraw(peer, label, status);
  }

  release(peer: LdpIdentifier, fec: PwFec, _label: MplsLabel | undefined, status: number | undefined): void {
    if (fec.kind !== 'gen-pwid') return;
    this.neighborFor(peer, fec)?.ldp?.release(status);
  }

  notification(peer: LdpIdentifier, fec: PwFec, pwStatus: number): void {
    if (fec.kind !== 'gen-pwid') return;
    this.neighborFor(peer, fec)?.ldp?.notification(pwStatus);
  }

  macWithdraw(peer: LdpIdentifier, fec: PwFec, macs: readonly (readonly number[])[]): void {
    if (fec.kind !== 'gen-pwid') return;
    const instance = this.instanceFor(fec);
    if (instance === undefined) return;
    this.counters.macWithdrawsReceived++;
    const port = pseudowirePort(peer.lsrId);
    if (macs.length === 0) {
      instance.fdb.forgetExcept(port);
      return;
    }
    for (const octets of macs) {
      const mac = new MACAddress([...octets]).toString();
      if (instance.fdb.lookup(mac) === port) instance.fdb.forget(mac);
    }
  }

  private localBgpInstances(): readonly VplsLocalInstance[] {
    return [...this.instances.values()].flatMap(({ bgp, config }) => bgp === undefined ? [] : [{
      name: config.name, rd: bgp.config.rd, routeTarget: bgp.config.routeTarget, veId: bgp.block.veId,
      veBlockOffset: bgp.block.offset, veBlockSize: bgp.block.size, labelBase: bgp.block.base.value,
      layer2Info: { encapsulationType: VPLS_ENCAPSULATION_TYPE, controlWord: bgp.block.controlWord, sequenced: false, mtu: bgp.block.mtu() },
    }]);
  }

  private bgpAdvertised(advertisement: VplsRemoteAdvertisement): void {
    const instance = this.instances.get(advertisement.instance);
    if (instance?.bgp === undefined || advertisement.nlri.veId === instance.bgp.block.veId) return;
    this.bgpWithdrawn(advertisement.instance, advertisement.nlri);
    const peer = new IPAddress(advertisement.nextHop);
    instance.neighbors.set(peer.toString(), {
      peer, veId: advertisement.nlri.veId,
      session: new BgpPseudowire(instance.bgp.block, advertisement.nlri.veId, advertisement, () => true),
    });
  }

  private bgpWithdrawn(name: string, nlri: BgpVplsNlri): void {
    const instance = this.instances.get(name);
    const stale = [...(instance?.neighbors.values() ?? [])].find(n => n.ldp === undefined && n.veId === nlri.veId);
    if (instance === undefined || stale === undefined) return;
    instance.neighbors.delete(stale.peer.toString());
    instance.fdb.forgetPort(pseudowirePort(stale.peer));
  }

  private instance(name: string): Instance {
    const instance = this.instances.get(name);
    if (instance === undefined) throw new Error(`no VPLS named ${name}`);
    return instance;
  }

  private owner(iface: string): Instance | undefined {
    return [...this.instances.values()].find(instance => instance.attachmentCircuits.has(iface));
  }

  private instanceFor(fec: GeneralizedPwFec): Instance | undefined {
    const vpnId = agiValue(fec.agi.value);
    return [...this.instances.values()].find(instance => instance.config.vpnId === vpnId);
  }

  private neighborFor(peer: LdpIdentifier, fec: GeneralizedPwFec): Neighbor | undefined {
    return this.instanceFor(fec)?.neighbors.get(peer.lsrId.toString());
  }

  private mtuOf(instance: Instance): number {
    const first = [...instance.attachmentCircuits][0];
    return first === undefined ? 1500 : this.host.attachmentMtu(first);
  }

  private fecOf(instance: Instance, controlWord: boolean, withParameters: boolean): GeneralizedPwFec {
    return {
      kind: 'gen-pwid', controlWord, pwType: PW_TYPE_ETHERNET_RAW,
      agi: { type: VPLS_AGI_TYPE, value: agiBytes(instance.config.vpnId) }, saii: NULL_IDENTIFIER, taii: NULL_IDENTIFIER,
      interfaceParameters: withParameters ? [mtuParameter(this.mtuOf(instance))] : [],
    };
  }

  private flood(instance: Instance, frame: EthernetFrame, source: string, toPseudowires: boolean): void {
    this.counters.flooded++;
    for (const iface of instance.attachmentCircuits) {
      if (attachmentPort(iface) !== source) this.host.sendFrame(iface, frame);
    }
    if (!toPseudowires) return;
    for (const neighbor of instance.neighbors.values()) this.sendOverPseudowire(instance, neighbor, frame);
  }

  private deliverTo(instance: Instance, port: string, frame: EthernetFrame): void {
    if (port.startsWith('ac:')) {
      this.counters.forwarded++;
      this.host.sendFrame(port.slice(3), frame);
      return;
    }
    const neighbor = instance.neighbors.get(port.slice(3));
    if (neighbor === undefined) {
      this.counters.droppedDown++;
      return;
    }
    this.counters.forwarded++;
    this.sendOverPseudowire(instance, neighbor, frame);
  }

  private sendOverPseudowire(instance: Instance, neighbor: Neighbor, frame: EthernetFrame): void {
    const remote = neighbor.session.remote;
    if (neighbor.session.blocker() !== null || remote === null) {
      this.counters.droppedDown++;
      return;
    }
    const payload: PseudowirePayload = {
      type: 'pw-ethernet', controlWord: neighbor.session.sendsControlWord ? controlWordOf(0) : null, frame,
    };
    const imposed = this.mpls().imposeUnderlay(payload, remote.label, neighbor.peer);
    if (imposed === null) {
      this.counters.droppedDown++;
      return;
    }
    void instance;
    this.host.transmit(imposed.iface, imposed.nextHop, imposed.packet);
  }
}
