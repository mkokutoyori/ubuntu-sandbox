import { type IPAddress, ethernetFrameBytesWithoutFcs, type EthernetFrame } from '@/network/core/types';
import type { LdpEngine, LdpPwHandler } from '@/network/ldp/LdpEngine';
import type { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import type { PwFec, PwIdFec } from '@/network/ldp/LdpMessages';
import type { MplsEngine } from '@/network/mpls/MplsEngine';
import type { MplsLabel } from '@/network/mpls/MplsLabel';
import type { MplsPacket } from '@/network/mpls/MplsPacket';
import { controlWordOf, isValidControlWord, type PseudowirePayload } from './PseudowirePacket';
import {
  PseudowireSession, mtuParameter, mtuOf, type ControlWordPreference, type RemoteMapping,
} from './PseudowireSession';

export const PW_TYPE_ETHERNET_RAW = 5;
const ETHERNET_HEADER_BYTES = 14;

export type { ControlWordPreference };

export interface PseudowireConfig {
  readonly attachmentCircuit: string;
  readonly peer: IPAddress;
  readonly pwId: number;
  readonly controlWord: ControlWordPreference;
  readonly groupId: number;
  readonly pwClass?: string;
}

export interface PseudowireHost {
  attachmentMtu(iface: string): number;
  attachmentUp(iface: string): boolean;
  sendFrame(iface: string, frame: EthernetFrame): void;
  transmit(iface: string, nextHop: IPAddress, packet: MplsPacket): void;
}

export interface PseudowireView {
  readonly attachmentCircuit: string;
  readonly peer: IPAddress;
  readonly pwId: number;
  readonly pwType: number;
  readonly localLabel: MplsLabel | null;
  readonly remoteLabel: MplsLabel | null;
  readonly controlWord: boolean;
  readonly state: 'up' | 'down';
  readonly reason: string | null;
  readonly pwClass: string | null;
  readonly mtu: number;
  readonly remoteMtu: number | null;
  readonly remoteGroupId: number | null;
  readonly createdAtMs: number;
  readonly statusChangedAtMs: number;
  readonly statistics: PseudowireStatistics;
}

export interface PseudowireStatistics {
  receivedPackets: number;
  receivedBytes: number;
  sentPackets: number;
  sentBytes: number;
  receiveDrops: number;
  sendDrops: number;
}

export interface PseudowireCounters {
  encapsulated: number;
  decapsulated: number;
  droppedDown: number;
  droppedMtu: number;
  droppedControlWord: number;
}

interface Wire {
  readonly config: PseudowireConfig;
  readonly session: PseudowireSession;
  readonly createdAtMs: number;
  readonly statistics: PseudowireStatistics;
  lastState: 'up' | 'down';
  statusChangedAtMs: number;
}

export interface PseudowireClass {
  readonly encapsulation: 'mpls';
  readonly controlWord: boolean;
}

function remoteKey(peer: IPAddress, pwId: number): string {
  return `${peer}|${pwId}`;
}

export function pwFecOf(config: PseudowireConfig, controlWord: boolean, mtu: number | null): PwIdFec {
  return {
    kind: 'pwid', controlWord, pwType: PW_TYPE_ETHERNET_RAW, groupId: config.groupId, pwId: config.pwId,
    interfaceParameters: mtu === null ? [] : [mtuParameter(mtu)],
  };
}

export class PseudowireEngine implements LdpPwHandler {
  readonly counters: PseudowireCounters = { encapsulated: 0, decapsulated: 0, droppedDown: 0, droppedMtu: 0, droppedControlWord: 0 };
  private readonly wires = new Map<string, Wire>();
  private readonly pendingRemote = new Map<string, RemoteMapping>();

  constructor(
    private readonly host: PseudowireHost,
    private readonly ldp: () => LdpEngine,
    private readonly mpls: () => MplsEngine,
  ) {}

  add(config: PseudowireConfig): void {
    if (this.wires.has(config.attachmentCircuit)) throw new Error(`${config.attachmentCircuit} already carries a pseudowire`);
    const iface = config.attachmentCircuit;
    const session = new PseudowireSession({
      peer: config.peer, controlWord: config.controlWord, ilmEntry: { kind: 'pw', owner: 'xconnect', endpoint: iface },
      fec: (controlWord, withParameters) => pwFecOf(config, controlWord, withParameters ? this.host.attachmentMtu(iface) : null),
      matches: fec => fec.kind === 'pwid' && fec.pwId === config.pwId && fec.pwType === PW_TYPE_ETHERNET_RAW,
      mtu: () => this.host.attachmentMtu(iface),
      localUp: () => this.host.attachmentUp(iface),
    }, this.ldp, this.mpls);
    const now = this.ldp().nowMs();
    this.wires.set(iface, {
      config, session, createdAtMs: now, lastState: 'down', statusChangedAtMs: now,
      statistics: { receivedPackets: 0, receivedBytes: 0, sentPackets: 0, sentBytes: 0, receiveDrops: 0, sendDrops: 0 },
    });
    const held = this.pendingRemote.get(remoteKey(config.peer, config.pwId));
    if (held !== undefined) {
      session.adopt(held);
      this.pendingRemote.delete(remoteKey(config.peer, config.pwId));
    }
    this.ldp().addPwHandler(this);
    this.ldp().addTargetedPeer(config.peer);
    session.advertise();
  }

  remove(attachmentCircuit: string): void {
    const wire = this.wires.get(attachmentCircuit);
    if (wire === undefined) return;
    this.wires.delete(attachmentCircuit);
    wire.session.teardown();
    const stillTargeted = [...this.wires.values()].some(other => other.config.peer.equals(wire.config.peer));
    if (!stillTargeted) this.ldp().removeTargetedPeer(wire.config.peer);
  }

  views(): readonly PseudowireView[] {
    return [...this.wires.values()].map(wire => {
      this.observe(wire);
      const { config, session } = wire;
      return {
        attachmentCircuit: config.attachmentCircuit, peer: config.peer, pwId: config.pwId, pwType: PW_TYPE_ETHERNET_RAW,
        localLabel: session.localLabel, remoteLabel: session.remote?.label ?? null,
        controlWord: session.usesControlWord, state: wire.lastState, reason: session.blocker(),
        pwClass: config.pwClass ?? null, mtu: this.host.attachmentMtu(config.attachmentCircuit), remoteMtu: session.remote?.mtu ?? null,
        remoteGroupId: session.remote === null ? null : 0, createdAtMs: wire.createdAtMs, statusChangedAtMs: wire.statusChangedAtMs,
        statistics: { ...wire.statistics },
      };
    });
  }

  private observeAll(): void {
    for (const wire of this.wires.values()) this.observe(wire);
  }

  private observe(wire: Wire): void {
    const state = wire.session.blocker() === null ? 'up' : 'down';
    if (state === wire.lastState) return;
    wire.lastState = state;
    wire.statusChangedAtMs = this.ldp().nowMs();
  }

  private readonly pwClasses = new Map<string, PseudowireClass>();

  definePseudowireClass(name: string): void {
    if (!this.pwClasses.has(name)) this.pwClasses.set(name, { encapsulation: 'mpls', controlWord: false });
  }

  removePseudowireClass(name: string): void {
    this.pwClasses.delete(name);
  }

  pseudowireClass(name: string): PseudowireClass | undefined {
    return this.pwClasses.get(name);
  }

  pseudowireClasses(): ReadonlyMap<string, PseudowireClass> {
    return this.pwClasses;
  }

  setClassControlWord(name: string, enabled: boolean): void {
    const current = this.pwClasses.get(name);
    if (current === undefined) return;
    this.pwClasses.set(name, { ...current, controlWord: enabled });
    for (const wire of [...this.wires.values()].filter(candidate => candidate.config.pwClass === name)) {
      const config = { ...wire.config, controlWord: enabled ? 'preferred' as const : 'not-preferred' as const };
      this.remove(wire.config.attachmentCircuit);
      this.add(config);
    }
  }

  configuration(): readonly PseudowireConfig[] {
    return [...this.wires.values()].map(wire => wire.config);
  }

  attaches(iface: string): boolean {
    return this.wires.has(iface);
  }

  ingress(iface: string, frame: EthernetFrame): void {
    const wire = this.wires.get(iface);
    if (wire === undefined) return;
    const remote = wire.session.remote;
    if (wire.session.blocker() !== null || remote === null) {
      this.counters.droppedDown++;
      wire.statistics.sendDrops++;
      return;
    }
    const payload: PseudowirePayload = {
      type: 'pw-ethernet', controlWord: wire.session.usesControlWord ? controlWordOf(0) : null, frame,
    };
    const imposed = this.mpls().imposeUnderlay(payload, remote.label, wire.config.peer);
    if (imposed === null) {
      this.counters.droppedDown++;
      wire.statistics.sendDrops++;
      return;
    }
    this.counters.encapsulated++;
    wire.statistics.sentPackets++;
    wire.statistics.sentBytes += ethernetFrameBytesWithoutFcs(frame);
    this.host.transmit(imposed.iface, imposed.nextHop, imposed.packet);
  }

  egress(attachmentCircuit: string, payload: PseudowirePayload): void {
    const wire = this.wires.get(attachmentCircuit);
    if (wire === undefined || wire.session.blocker() !== null) {
      this.counters.droppedDown++;
      if (wire !== undefined) wire.statistics.receiveDrops++;
      return;
    }
    if (wire.session.usesControlWord !== (payload.controlWord !== null)
      || (payload.controlWord !== null && !isValidControlWord(payload.controlWord))) {
      this.counters.droppedControlWord++;
      wire.statistics.receiveDrops++;
      return;
    }
    const length = ethernetFrameBytesWithoutFcs(payload.frame) - ETHERNET_HEADER_BYTES;
    if (length > this.host.attachmentMtu(attachmentCircuit)) {
      this.counters.droppedMtu++;
      wire.statistics.receiveDrops++;
      return;
    }
    this.counters.decapsulated++;
    wire.statistics.receivedPackets++;
    wire.statistics.receivedBytes += ethernetFrameBytesWithoutFcs(payload.frame);
    this.host.sendFrame(attachmentCircuit, payload.frame);
  }

  attachmentStateChanged(iface: string): void {
    this.wires.get(iface)?.session.localStateChanged();
    this.observeAll();
  }

  sessionOperational(peer: LdpIdentifier): void {
    for (const { config, session } of this.wires.values()) if (config.peer.equals(peer.lsrId)) session.advertise();
    this.observeAll();
  }

  sessionClosed(peer: LdpIdentifier): void {
    for (const { config, session } of this.wires.values()) if (config.peer.equals(peer.lsrId)) session.sessionClosed();
    this.observeAll();
  }

  mapping(peer: LdpIdentifier, fec: PwFec, label: MplsLabel, pwStatus: number | undefined): void {
    if (fec.kind !== 'pwid' || fec.pwId === null) return;
    const wire = this.find(peer, fec);
    if (wire === undefined) {
      this.pendingRemote.set(remoteKey(peer.lsrId, fec.pwId), {
        label, controlWord: fec.controlWord, mtu: mtuOf(fec), statusTlv: pwStatus !== undefined, status: pwStatus ?? 0,
      });
      return;
    }
    wire.session.mapping(peer, fec, label, pwStatus);
    this.observeAll();
  }

  withdraw(peer: LdpIdentifier, fec: PwFec, label: MplsLabel | undefined, status: number | undefined): void {
    if (fec.kind !== 'pwid') return;
    if (fec.pwId !== null) this.pendingRemote.delete(remoteKey(peer.lsrId, fec.pwId));
    this.find(peer, fec)?.session.withdraw(peer, label, status);
    this.observeAll();
  }

  release(peer: LdpIdentifier, fec: PwFec, _label: MplsLabel | undefined, status: number | undefined): void {
    if (fec.kind !== 'pwid') return;
    this.find(peer, fec)?.session.release(status);
    this.observeAll();
  }

  notification(peer: LdpIdentifier, fec: PwFec, pwStatus: number): void {
    if (fec.kind !== 'pwid') return;
    for (const { config, session } of this.wires.values()) {
      if (!config.peer.equals(peer.lsrId)) continue;
      const wildcard = fec.pwId === null && config.groupId === fec.groupId;
      if (wildcard || fec.pwId === config.pwId) session.notification(pwStatus);
    }
    this.observeAll();
  }

  macWithdraw(): void {}

  private find(peer: LdpIdentifier, fec: PwIdFec): Wire | undefined {
    if (fec.pwId === null) return undefined;
    return [...this.wires.values()].find(wire => wire.config.peer.equals(peer.lsrId)
      && wire.session.spec.matches(fec));
  }
}
