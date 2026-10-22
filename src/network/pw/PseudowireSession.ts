import type { IPAddress } from '@/network/core/types';
import type { LdpEngine } from '@/network/ldp/LdpEngine';
import type { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import { StatusCode, type PwFec, type PwInterfaceParameter } from '@/network/ldp/LdpMessages';
import type { PseudowireEntry } from '@/network/mpls/Lfib';
import type { MplsEngine } from '@/network/mpls/MplsEngine';
import type { MplsLabel } from '@/network/mpls/MplsLabel';

export const PW_STATUS_FORWARDING = 0;
export const PW_STATUS_NOT_FORWARDING = 1;
export const PW_INTERFACE_PARAMETER_MTU = 0x01;

export type ControlWordPreference = 'preferred' | 'not-preferred';

export interface PseudowireSessionSpec {
  readonly peer: IPAddress;
  readonly controlWord: ControlWordPreference;
  readonly ilmEntry: PseudowireEntry;
  fec(controlWord: boolean, withParameters: boolean): PwFec;
  matches(fec: PwFec): boolean;
  mtu(): number;
  localUp(): boolean;
}

export interface RemoteMapping {
  readonly label: MplsLabel;
  readonly controlWord: boolean;
  readonly mtu: number | null;
  readonly statusTlv: boolean;
  status: number;
}

export function mtuParameter(mtu: number): PwInterfaceParameter {
  return { type: PW_INTERFACE_PARAMETER_MTU, value: Uint8Array.of(mtu >> 8, mtu & 0xff) };
}

export function mtuOf(fec: PwFec): number | null {
  const parameter = fec.interfaceParameters.find(candidate => candidate.type === PW_INTERFACE_PARAMETER_MTU);
  return parameter !== undefined && parameter.value.length === 2 ? (parameter.value[0] << 8) | parameter.value[1] : null;
}

export class PseudowireSession {
  localLabel: MplsLabel | null = null;
  advertisedControlWord: boolean | null = null;
  remote: RemoteMapping | null = null;
  negotiated: boolean | null = null;
  lastError: string | null = null;

  constructor(
    readonly spec: PseudowireSessionSpec,
    private readonly ldp: () => LdpEngine,
    private readonly mpls: () => MplsEngine,
  ) {}

  get usesControlWord(): boolean {
    return this.advertisedControlWord === true && this.remote?.controlWord === true;
  }

  localStatus(): number {
    return this.spec.localUp() ? PW_STATUS_FORWARDING : PW_STATUS_NOT_FORWARDING;
  }

  adopt(held: RemoteMapping): void {
    this.remote = held;
  }

  advertise(): void {
    if (this.advertisedControlWord !== null) return;
    if (this.negotiated === false && !this.spec.localUp()) return;
    const preferred = this.spec.controlWord === 'preferred';
    this.advertisedControlWord = this.remote === null ? preferred : this.remote.controlWord && preferred;
    if (!this.sendMapping()) {
      this.advertisedControlWord = null;
      return;
    }
    if (this.remote !== null && this.remote.controlWord === this.advertisedControlWord) this.accept(this.remote);
  }

  localStateChanged(): void {
    if (this.negotiated === true) {
      this.ldp().sendToPeer(this.spec.peer, [{
        kind: 'notification', id: this.ldp().nextMessageId(), statusCode: StatusCode.PwStatus, forward: false,
        referencedMessageId: 0, referencedMessageType: 0, pwStatus: this.localStatus(), fec: [this.spec.fec(false, false)],
      }]);
      return;
    }
    if (this.spec.localUp()) {
      this.advertise();
    } else if (this.localLabel !== null && this.advertisedControlWord !== null) {
      this.ldp().sendToPeer(this.spec.peer, [{
        kind: 'label-withdraw', id: this.ldp().nextMessageId(), fec: [this.spec.fec(this.advertisedControlWord, false)], label: this.localLabel,
      }]);
      this.advertisedControlWord = null;
    }
  }

  sessionClosed(): void {
    this.remote = null;
    this.negotiated = null;
    this.advertisedControlWord = null;
  }

  mapping(peer: LdpIdentifier, fec: PwFec, label: MplsLabel, pwStatus: number | undefined): void {
    const received: RemoteMapping = {
      label, controlWord: fec.controlWord, mtu: mtuOf(fec), statusTlv: pwStatus !== undefined, status: pwStatus ?? 0,
    };
    if (this.advertisedControlWord === null) {
      this.remote = received;
      return;
    }
    if (received.controlWord === this.advertisedControlWord) {
      this.accept(received);
      return;
    }
    if (received.controlWord && !this.advertisedControlWord) {
      this.remote = null;
      return;
    }
    this.ldp().sendToPeer(peer.lsrId, [{
      kind: 'label-withdraw', id: this.ldp().nextMessageId(), fec: [this.spec.fec(true, false)],
      label: this.localLabel as MplsLabel, status: StatusCode.WrongCBit,
    }]);
    this.advertisedControlWord = false;
    this.sendMapping();
    this.accept(received);
  }

  withdraw(peer: LdpIdentifier, label: MplsLabel | undefined, status: number | undefined): void {
    if (label !== undefined && this.remote !== null && !this.remote.label.equals(label)) return;
    this.remote = null;
    this.negotiated = null;
    if (status === StatusCode.WrongCBit) return;
    this.ldp().sendToPeer(peer.lsrId, [{
      kind: 'label-release', id: this.ldp().nextMessageId(), fec: [this.spec.fec(false, false)], ...(label ? { label } : {}),
    }]);
  }

  release(status: number | undefined): void {
    this.advertisedControlWord = null;
    if (status === StatusCode.IllegalCBit) this.lastError = 'peer refused the control word (Illegal C-bit)';
  }

  notification(pwStatus: number): void {
    if (this.remote !== null) this.remote.status = pwStatus;
  }

  teardown(): void {
    if (this.localLabel === null) return;
    this.ldp().sendToPeer(this.spec.peer, [{
      kind: 'label-withdraw', id: this.ldp().nextMessageId(), fec: [this.spec.fec(this.advertisedControlWord ?? false, false)],
      label: this.localLabel,
    }]);
    this.mpls().lfib.releaseLabel(this.localLabel);
    this.localLabel = null;
  }

  blocker(): string | null {
    if (this.lastError !== null) return this.lastError;
    if (this.localLabel === null || this.advertisedControlWord === null) return 'no label mapping sent';
    if (this.remote === null) return 'no label mapping from the peer';
    if (this.remote.controlWord !== this.advertisedControlWord) return 'control word not agreed';
    if (this.remote.mtu === null || this.remote.mtu !== this.spec.mtu()) return 'interface MTU mismatch';
    if (!this.spec.localUp()) return 'attachment circuit down';
    if (this.remote.status !== PW_STATUS_FORWARDING) return 'peer reports the pseudowire not forwarding';
    return null;
  }

  private accept(received: RemoteMapping): void {
    this.remote = received;
    this.negotiated = received.statusTlv;
    this.lastError = null;
  }

  private sendMapping(): boolean {
    if (this.localLabel === null) {
      this.localLabel = this.mpls().lfib.allocateLabel();
      this.mpls().lfib.setIlm(this.localLabel, this.spec.ilmEntry);
    }
    return this.ldp().sendToPeer(this.spec.peer, [{
      kind: 'label-mapping', id: this.ldp().nextMessageId(), fec: [this.spec.fec(this.advertisedControlWord ?? false, true)],
      label: this.localLabel, pwStatus: this.localStatus(),
    }]);
  }
}
