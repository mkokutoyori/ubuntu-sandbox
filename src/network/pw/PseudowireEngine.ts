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
    this.wires.set(iface, { config, session });
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
    return [...this.wires.values()].map(({ config, session }) => ({
      attachmentCircuit: config.attachmentCircuit, peer: config.peer, pwId: config.pwId, pwType: PW_TYPE_ETHERNET_RAW,
      localLabel: session.localLabel, remoteLabel: session.remote?.label ?? null,
      controlWord: session.usesControlWord, state: session.blocker() === null ? 'up' : 'down', reason: session.blocker(),
    }));
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
      return;
    }
    const payload: PseudowirePayload = {
      type: 'pw-ethernet', controlWord: wire.session.usesControlWord ? controlWordOf(0) : null, frame,
    };
    const imposed = this.mpls().imposeUnderlay(payload, remote.label, wire.config.peer);
    if (imposed === null) {
      this.counters.droppedDown++;
      return;
    }
    this.counters.encapsulated++;
    this.host.transmit(imposed.iface, imposed.nextHop, imposed.packet);
  }

  egress(attachmentCircuit: string, payload: PseudowirePayload): void {
    const wire = this.wires.get(attachmentCircuit);
    if (wire === undefined || wire.session.blocker() !== null) {
      this.counters.droppedDown++;
      return;
    }
    if (wire.session.usesControlWord !== (payload.controlWord !== null)
      || (payload.controlWord !== null && !isValidControlWord(payload.controlWord))) {
      this.counters.droppedControlWord++;
      return;
    }
    const length = ethernetFrameBytesWithoutFcs(payload.frame) - ETHERNET_HEADER_BYTES;
    if (length > this.host.attachmentMtu(attachmentCircuit)) {
      this.counters.droppedMtu++;
      return;
    }
    this.counters.decapsulated++;
    this.host.sendFrame(attachmentCircuit, payload.frame);
  }

  attachmentStateChanged(iface: string): void {
    this.wires.get(iface)?.session.localStateChanged();
  }

  sessionOperational(peer: LdpIdentifier): void {
    for (const { config, session } of this.wires.values()) if (config.peer.equals(peer.lsrId)) session.advertise();
  }

  sessionClosed(peer: LdpIdentifier): void {
    for (const { config, session } of this.wires.values()) if (config.peer.equals(peer.lsrId)) session.sessionClosed();
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
  }

  withdraw(peer: LdpIdentifier, fec: PwFec, label: MplsLabel | undefined, status: number | undefined): void {
    if (fec.kind !== 'pwid') return;
    if (fec.pwId !== null) this.pendingRemote.delete(remoteKey(peer.lsrId, fec.pwId));
    this.find(peer, fec)?.session.withdraw(peer, label, status);
  }

  release(peer: LdpIdentifier, fec: PwFec, _label: MplsLabel | undefined, status: number | undefined): void {
    if (fec.kind !== 'pwid') return;
    this.find(peer, fec)?.session.release(status);
  }

  notification(peer: LdpIdentifier, fec: PwFec, pwStatus: number): void {
    if (fec.kind !== 'pwid') return;
    for (const { config, session } of this.wires.values()) {
      if (!config.peer.equals(peer.lsrId)) continue;
      const wildcard = fec.pwId === null && config.groupId === fec.groupId;
      if (wildcard || fec.pwId === config.pwId) session.notification(pwStatus);
    }
  }

  macWithdraw(): void {}

  private find(peer: LdpIdentifier, fec: PwIdFec): Wire | undefined {
    if (fec.pwId === null) return undefined;
    return [...this.wires.values()].find(wire => wire.config.peer.equals(peer.lsrId)
      && wire.session.spec.matches(fec));
  }
}
