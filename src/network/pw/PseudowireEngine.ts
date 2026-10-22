import { IPAddress, ethernetFrameBytesWithoutFcs, type EthernetFrame } from '@/network/core/types';
import type { LdpEngine, LdpPwHandler } from '@/network/ldp/LdpEngine';
import type { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import { StatusCode, type PwIdFec, type PwInterfaceParameter } from '@/network/ldp/LdpMessages';
import type { MplsEngine } from '@/network/mpls/MplsEngine';
import type { MplsLabel } from '@/network/mpls/MplsLabel';
import type { MplsPacket } from '@/network/mpls/MplsPacket';
import { controlWordOf, isValidControlWord, type PseudowirePayload } from './PseudowirePacket';

export const PW_TYPE_ETHERNET_RAW = 5;
export const PW_STATUS_FORWARDING = 0;
export const PW_STATUS_NOT_FORWARDING = 1;
const INTERFACE_PARAMETER_MTU = 0x01;
const ETHERNET_HEADER_BYTES = 14;

export type ControlWordPreference = 'preferred' | 'not-preferred';

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

interface RemoteMapping {
  readonly label: MplsLabel;
  readonly controlWord: boolean;
  readonly mtu: number | null;
  readonly statusTlv: boolean;
  status: number;
}

interface Pseudowire {
  readonly config: PseudowireConfig;
  localLabel: MplsLabel | null;
  advertisedControlWord: boolean | null;
  remote: RemoteMapping | null;
  negotiated: boolean | null;
  lastError: string | null;
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

function remoteKey(peer: IPAddress, pwId: number): string {
  return `${peer}|${pwId}`;
}

function mtuParameter(mtu: number): PwInterfaceParameter {
  return { type: INTERFACE_PARAMETER_MTU, value: Uint8Array.of(mtu >> 8, mtu & 0xff) };
}

function mtuOf(fec: PwIdFec): number | null {
  const parameter = fec.interfaceParameters.find(candidate => candidate.type === INTERFACE_PARAMETER_MTU);
  return parameter !== undefined && parameter.value.length === 2 ? (parameter.value[0] << 8) | parameter.value[1] : null;
}

export class PseudowireEngine implements LdpPwHandler {
  readonly counters: PseudowireCounters = { encapsulated: 0, decapsulated: 0, droppedDown: 0, droppedMtu: 0, droppedControlWord: 0 };
  private readonly wires = new Map<string, Pseudowire>();
  private readonly pendingRemote = new Map<string, RemoteMapping>();

  constructor(
    private readonly host: PseudowireHost,
    private readonly ldp: () => LdpEngine,
    private readonly mpls: () => MplsEngine,
  ) {}

  add(config: PseudowireConfig): void {
    if (this.wires.has(config.attachmentCircuit)) throw new Error(`${config.attachmentCircuit} already carries a pseudowire`);
    const wire: Pseudowire = {
      config, localLabel: null, advertisedControlWord: null, remote: null, negotiated: null, lastError: null,
    };
    this.wires.set(config.attachmentCircuit, wire);
    const held = this.pendingRemote.get(remoteKey(config.peer, config.pwId));
    if (held !== undefined) {
      wire.remote = held;
      this.pendingRemote.delete(remoteKey(config.peer, config.pwId));
    }
    this.ldp().setPwHandler(this);
    this.ldp().addTargetedPeer(config.peer);
    this.advertise(wire);
  }

  remove(attachmentCircuit: string): void {
    const wire = this.wires.get(attachmentCircuit);
    if (wire === undefined) return;
    this.wires.delete(attachmentCircuit);
    if (wire.localLabel !== null) {
      this.ldp().sendToPeer(wire.config.peer, [{
        kind: 'label-withdraw', id: this.ldp().nextMessageId(), fec: [this.fecOf(wire, false)], label: wire.localLabel,
      }]);
      this.mpls().lfib.releaseLabel(wire.localLabel);
    }
    const stillTargeted = [...this.wires.values()].some(other => other.config.peer.equals(wire.config.peer));
    if (!stillTargeted) this.ldp().removeTargetedPeer(wire.config.peer);
  }

  views(): readonly PseudowireView[] {
    return [...this.wires.values()].map(wire => ({
      attachmentCircuit: wire.config.attachmentCircuit, peer: wire.config.peer, pwId: wire.config.pwId, pwType: PW_TYPE_ETHERNET_RAW,
      localLabel: wire.localLabel, remoteLabel: wire.remote?.label ?? null,
      controlWord: this.usesControlWord(wire), state: this.blocker(wire) === null ? 'up' : 'down', reason: this.blocker(wire),
    }));
  }

  attaches(iface: string): boolean {
    return this.wires.has(iface);
  }

  ingress(iface: string, frame: EthernetFrame): void {
    const wire = this.wires.get(iface);
    if (wire === undefined) return;
    if (this.blocker(wire) !== null || wire.remote === null) {
      this.counters.droppedDown++;
      return;
    }
    const payload: PseudowirePayload = {
      type: 'pw-ethernet', controlWord: this.usesControlWord(wire) ? controlWordOf(0) : null, frame,
    };
    const imposed = this.mpls().imposeUnderlay(payload, wire.remote.label, wire.config.peer);
    if (imposed === null) {
      this.counters.droppedDown++;
      return;
    }
    this.counters.encapsulated++;
    this.host.transmit(imposed.iface, imposed.nextHop, imposed.packet);
  }

  egress(attachmentCircuit: string, payload: PseudowirePayload): void {
    const wire = this.wires.get(attachmentCircuit);
    if (wire === undefined || this.blocker(wire) !== null) {
      this.counters.droppedDown++;
      return;
    }
    const expectsControlWord = this.usesControlWord(wire);
    if (expectsControlWord !== (payload.controlWord !== null)
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
    const wire = this.wires.get(iface);
    if (wire === undefined) return;
    const up = this.host.attachmentUp(iface);
    if (wire.negotiated === true) {
      this.ldp().sendToPeer(wire.config.peer, [{
        kind: 'notification', id: this.ldp().nextMessageId(), statusCode: StatusCode.PwStatus, forward: false,
        referencedMessageId: 0, referencedMessageType: 0, pwStatus: this.localStatus(wire), fec: [this.fecOf(wire, false)],
      }]);
      return;
    }
    if (up) {
      this.advertise(wire);
    } else if (wire.localLabel !== null && wire.advertisedControlWord !== null) {
      this.ldp().sendToPeer(wire.config.peer, [{
        kind: 'label-withdraw', id: this.ldp().nextMessageId(), fec: [this.fecOf(wire, false)], label: wire.localLabel,
      }]);
      wire.advertisedControlWord = null;
    }
  }

  sessionOperational(peer: LdpIdentifier): void {
    for (const wire of this.wires.values()) if (wire.config.peer.equals(peer.lsrId)) this.advertise(wire);
  }

  sessionClosed(peer: LdpIdentifier): void {
    for (const wire of this.wires.values()) {
      if (!wire.config.peer.equals(peer.lsrId)) continue;
      wire.remote = null;
      wire.negotiated = null;
      wire.advertisedControlWord = null;
    }
  }

  mapping(peer: LdpIdentifier, fec: PwIdFec, label: MplsLabel, pwStatus: number | undefined): void {
    if (fec.pwId === null) return;
    const received: RemoteMapping = {
      label, controlWord: fec.controlWord, mtu: mtuOf(fec), statusTlv: pwStatus !== undefined, status: pwStatus ?? 0,
    };
    const wire = this.find(peer, fec);
    if (wire === undefined) {
      this.pendingRemote.set(remoteKey(peer.lsrId, fec.pwId), received);
      return;
    }
    if (wire.advertisedControlWord === null) {
      wire.remote = received;
      return;
    }
    if (received.controlWord === wire.advertisedControlWord) {
      this.accept(wire, received);
      return;
    }
    if (received.controlWord && !wire.advertisedControlWord) {
      wire.remote = null;
      return;
    }
    this.ldp().sendToPeer(peer.lsrId, [{
      kind: 'label-withdraw', id: this.ldp().nextMessageId(), fec: [this.fecOf(wire, false)],
      label: wire.localLabel as MplsLabel, status: StatusCode.WrongCBit,
    }]);
    wire.advertisedControlWord = false;
    this.sendMapping(wire);
    this.accept(wire, received);
  }

  withdraw(peer: LdpIdentifier, fec: PwIdFec, label: MplsLabel | undefined, status: number | undefined): void {
    const wire = this.find(peer, fec);
    if (fec.pwId !== null) this.pendingRemote.delete(remoteKey(peer.lsrId, fec.pwId));
    if (wire === undefined) return;
    if (label !== undefined && wire.remote !== null && !wire.remote.label.equals(label)) return;
    wire.remote = null;
    wire.negotiated = null;
    if (status === StatusCode.WrongCBit) return;
    this.ldp().sendToPeer(peer.lsrId, [{
      kind: 'label-release', id: this.ldp().nextMessageId(), fec: [this.fecOf(wire, false)], ...(label ? { label } : {}),
    }]);
  }

  release(peer: LdpIdentifier, fec: PwIdFec, _label: MplsLabel | undefined, status: number | undefined): void {
    const wire = this.find(peer, fec);
    if (wire === undefined) return;
    wire.advertisedControlWord = null;
    if (status === StatusCode.IllegalCBit) wire.lastError = 'peer refused the control word (Illegal C-bit)';
  }

  notification(peer: LdpIdentifier, fec: PwIdFec, pwStatus: number): void {
    for (const wire of this.wires.values()) {
      if (!wire.config.peer.equals(peer.lsrId) || wire.remote === null) continue;
      const wildcard = fec.pwId === null && wire.config.groupId === fec.groupId;
      if (wildcard || fec.pwId === wire.config.pwId) wire.remote.status = pwStatus;
    }
  }

  private accept(wire: Pseudowire, received: RemoteMapping): void {
    wire.remote = received;
    wire.negotiated = received.statusTlv;
    wire.lastError = null;
  }

  private find(peer: LdpIdentifier, fec: PwIdFec): Pseudowire | undefined {
    if (fec.pwId === null) return undefined;
    return [...this.wires.values()].find(wire => wire.config.peer.equals(peer.lsrId)
      && wire.config.pwId === fec.pwId && fec.pwType === PW_TYPE_ETHERNET_RAW);
  }

  private fecOf(wire: Pseudowire, withParameters: boolean): PwIdFec {
    return {
      kind: 'pwid', controlWord: wire.advertisedControlWord ?? false, pwType: PW_TYPE_ETHERNET_RAW,
      groupId: wire.config.groupId, pwId: wire.config.pwId,
      interfaceParameters: withParameters ? [mtuParameter(this.host.attachmentMtu(wire.config.attachmentCircuit))] : [],
    };
  }

  private localStatus(wire: Pseudowire): number {
    return this.host.attachmentUp(wire.config.attachmentCircuit) ? PW_STATUS_FORWARDING : PW_STATUS_NOT_FORWARDING;
  }

  private advertise(wire: Pseudowire): void {
    if (wire.advertisedControlWord !== null) return;
    if (wire.negotiated === false && !this.host.attachmentUp(wire.config.attachmentCircuit)) return;
    const preferred = wire.config.controlWord === 'preferred';
    wire.advertisedControlWord = wire.remote === null ? preferred : wire.remote.controlWord && preferred;
    if (!this.sendMapping(wire)) {
      wire.advertisedControlWord = null;
      return;
    }
    if (wire.remote !== null && wire.remote.controlWord === wire.advertisedControlWord) this.accept(wire, wire.remote);
  }

  private sendMapping(wire: Pseudowire): boolean {
    if (wire.localLabel === null) {
      wire.localLabel = this.mpls().lfib.allocateLabel();
      this.mpls().lfib.setIlm(wire.localLabel, { kind: 'pw', attachmentCircuit: wire.config.attachmentCircuit });
    }
    return this.ldp().sendToPeer(wire.config.peer, [{
      kind: 'label-mapping', id: this.ldp().nextMessageId(), fec: [this.fecOf(wire, true)], label: wire.localLabel,
      pwStatus: this.localStatus(wire),
    }]);
  }

  private usesControlWord(wire: Pseudowire): boolean {
    return wire.advertisedControlWord === true && wire.remote?.controlWord === true;
  }

  private blocker(wire: Pseudowire): string | null {
    if (wire.lastError !== null) return wire.lastError;
    if (wire.localLabel === null || wire.advertisedControlWord === null) return 'no label mapping sent';
    if (wire.remote === null) return 'no label mapping from the peer';
    if (wire.remote.controlWord !== wire.advertisedControlWord) return 'control word not agreed';
    const mtu = this.host.attachmentMtu(wire.config.attachmentCircuit);
    if (wire.remote.mtu === null || wire.remote.mtu !== mtu) return 'interface MTU mismatch';
    if (!this.host.attachmentUp(wire.config.attachmentCircuit)) return 'attachment circuit down';
    if (wire.remote.status !== PW_STATUS_FORWARDING) return 'peer reports the pseudowire not forwarding';
    return null;
  }
}
