import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { TimerSet } from '@/events/TimerSet';
import {
  type Dot1xConfig, type Dot1xPortRuntime, type Dot1xPortMode, type Dot1xPortState,
  type EapolPacket, type EapPacket,
  createDefaultDot1xConfig, defaultPortRuntime, isAuthorizedState,
  ETHERTYPE_EAPOL, EAPOL_PAE_GROUP_MAC,
} from './types';
import { eapPacketToWireHex, eapPacketFromWireHex } from '../radius/eap';
import { parseAuthorization, type RadiusAuthorization } from '../radius/authorization';
import type { EapRoundOutcome } from '../radius/RadiusClientAgent';
import {
  MACAddress,
  type EthernetFrame,
} from '../core/types';
import type { LinkSendRequest } from '../layers/link/LinkLayer';
import { Logger } from '../core/Logger';

/**
 * RADIUS EAP relay backend (RFC 3579) — one round per call, matching
 * `RadiusClientAgent.sendEapRound`; a router's real RADIUS client satisfies
 * this structurally, no adapter needed.
 */
export interface Dot1xRadiusBackend {
  sendEapRound(
    username: string, eapMessageHex: string, state: string | null,
    nas: { callingStationId?: string; calledStationId?: string },
  ): Promise<EapRoundOutcome>;
}

export interface Dot1xHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendOnLink(request: LinkSendRequest): boolean;
  onDot1xPortAuthorized?(portName: string, authorized: boolean): void;
  /** RFC 3580 §3.31 dynamic VLAN assignment from a RADIUS Access-Accept — actually moving the port is left to the caller. */
  onDot1xVlanAssigned?(portName: string, vlanId: number): void;
}

export class Dot1xAgent {
  private config: Dot1xConfig = createDefaultDot1xConfig();
  private radius: Dot1xRadiusBackend | null = null;
  private running = false;
  private nextEapId = 1;
  /** Per-port quiet-period timer (held → unauthorized, IEEE 802.1X). */
  private readonly heldTimers = new Map<string, symbol>();
  private readonly timers: TimerSet;

  constructor(
    private readonly host: Dot1xHost,
    private readonly getBus: () => IEventBus,
    getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    this.timers = new TimerSet(getScheduler);
  }

  start(): void { if (!this.running) this.running = true; }
  stop(): void {
    this.running = false;
    for (const h of this.heldTimers.values()) this.timers.clear(h);
    this.heldTimers.clear();
  }

  getConfig(): Readonly<Dot1xConfig> { return this.config; }

  setSystemAuthControl(on: boolean): void {
    this.config.enabled = on;
    if (!on) {
      for (const rt of this.config.ports.values()) {
        if (rt.mode === 'auto') this.transition(rt, 'authorized', 'config');
      }
    }
  }

  setRadiusBackend(backend: Dot1xRadiusBackend | null): void { this.radius = backend; }

  setPortMode(portName: string, mode: Dot1xPortMode): void {
    const rt = this.ensurePort(portName, mode);
    rt.mode = mode;
    let newState: Dot1xPortState;
    if (mode === 'force-authorized') newState = 'force-authorized';
    else if (mode === 'force-unauthorized') newState = 'force-unauthorized';
    else if (mode === 'disabled') newState = 'authorized';
    else newState = 'unauthorized';
    this.transition(rt, newState, 'config');
  }

  /**
   * Quiet period — how long a port stays `held` after too many failed
   * rounds before it will listen again. Applies to ports configured
   * from now on, and to the named port immediately when given one.
   */
  setHoldTime(ms: number, portName?: string): void {
    if (portName === undefined) {
      this.config.defaultHoldMs = ms;
      for (const rt of this.config.ports.values()) rt.holdMs = ms;
      return;
    }
    const rt = this.config.ports.get(portName);
    if (rt) rt.holdMs = ms;
  }

  addLocalUser(username: string, password: string): void {
    this.config.localUsers.set(username, { username, password });
  }

  removeLocalUser(username: string): void { this.config.localUsers.delete(username); }

  removePort(portName: string): void {
    this.config.ports.delete(portName);
  }

  getPortRuntime(portName: string): Dot1xPortRuntime | undefined {
    return this.config.ports.get(portName);
  }

  listPorts(): Dot1xPortRuntime[] {
    return Array.from(this.config.ports.values()).sort((a, b) => a.port.localeCompare(b.port));
  }

  isPortAuthorized(portName: string): boolean {
    const rt = this.config.ports.get(portName);
    if (!rt) return true;
    if (rt.mode === 'disabled') return true;
    return isAuthorizedState(rt.state);
  }

  handleFrame(portName: string, frame: EthernetFrame): boolean {
    if (!this.config.enabled) return false;
    if (frame.etherType !== ETHERTYPE_EAPOL) return false;
    const rt = this.config.ports.get(portName);
    if (!rt || rt.mode === 'disabled') return false;
    const payload = frame.payload as EapolPacket | undefined;
    if (!payload || payload.type !== 'eapol') return false;
    const supplicantMac = frame.srcMAC.toString();
    rt.lastSupplicantMac = supplicantMac;

    const eapIdentity = payload.eap?.eapType === 'identity'
      ? (payload.eap.payload ?? null) : null;
    this.getBus().publish({
      topic: 'dot1x.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, packetType: payload.packetType,
        supplicantMac, identity: eapIdentity,
      },
    });

    switch (payload.packetType) {
      case 'eapol-start':
        this.onEapolStart(rt);
        break;
      case 'eapol-logoff':
        this.onEapolLogoff(rt);
        break;
      case 'eap-packet':
        if (payload.eap) this.onEapPacket(rt, payload.eap);
        break;
      default:
        break;
    }
    return true;
  }

  private onEapolStart(rt: Dot1xPortRuntime): void {
    if (rt.mode !== 'auto') return;
    if (rt.holdUntilMs > Date.now()) return;
    this.transition(rt, 'authenticating', 'eapol-start');
    rt.reauthCount = 0;
    rt.pendingEapId = this.nextEapId++ & 0xff;
    const req: EapPacket = {
      type: 'eap', code: 'request',
      identifier: rt.pendingEapId,
      eapType: 'identity',
      payload: '',
    };
    this.sendEapol(rt, 'eap-packet', req);
  }

  private onEapolLogoff(rt: Dot1xPortRuntime): void {
    if (rt.mode !== 'auto') return;
    if (rt.state === 'authorized' || rt.state === 'authenticating') {
      this.transition(rt, 'unauthorized', 'eapol-logoff');
      rt.identity = null;
    }
  }

  private onEapPacket(rt: Dot1xPortRuntime, eap: EapPacket): void {
    if (rt.mode !== 'auto') return;
    if (eap.code !== 'response') return;
    if (eap.eapType === 'identity') {
      const identity = eap.payload ?? '';
      rt.identity = identity;
      rt.radiusState = null;
      this.transition(rt, 'authenticating', 'eap-response');
      this.startAuth(rt, eap, identity);
    } else if ((eap.eapType === 'md5-challenge' || eap.eapType === 'tls'
        || eap.eapType === 'peap' || eap.eapType === 'ttls')
        && rt.identity !== null && rt.radiusState !== null) {
      this.continueRadiusEap(rt, eap);
    }
  }

  /** Local user table short-circuits (no RADIUS round-trip); otherwise relay the EAP-Response/Identity as the first RADIUS EAP round (RFC 3579). */
  private startAuth(rt: Dot1xPortRuntime, eap: EapPacket, identity: string): void {
    if (this.config.localUsers.has(identity)) {
      this.finishAuth(rt, true, identity, 'local-accept');
      return;
    }
    if (!this.radius) {
      this.finishAuth(rt, false, identity, 'local-reject-unknown-user');
      return;
    }
    this.radius.sendEapRound(identity, eapPacketToWireHex(eap), null, this.nasAttrsFor(rt))
      .then((outcome) => this.handleRadiusOutcome(rt, identity, outcome))
      .catch(() => this.finishAuth(rt, false, identity, 'radius-reject'));
  }

  /** Relay the supplicant's EAP-Response/MD5-Challenge as the next RADIUS round, echoing the State from the Access-Challenge that carried the original challenge. */
  private continueRadiusEap(rt: Dot1xPortRuntime, eap: EapPacket): void {
    const identity = rt.identity!;
    const state = rt.radiusState;
    if (!this.radius) { this.finishAuth(rt, false, identity, 'radius-reject'); return; }
    this.radius.sendEapRound(identity, eapPacketToWireHex(eap), state, this.nasAttrsFor(rt))
      .then((outcome) => this.handleRadiusOutcome(rt, identity, outcome))
      .catch(() => this.finishAuth(rt, false, identity, 'radius-reject'));
  }

  private nasAttrsFor(rt: Dot1xPortRuntime): { callingStationId?: string; calledStationId?: string } {
    return {
      callingStationId: rt.lastSupplicantMac ?? undefined,
      calledStationId: this.host.getPort(rt.port)?.getMAC().toString(),
    };
  }

  private handleRadiusOutcome(rt: Dot1xPortRuntime, identity: string, outcome: EapRoundOutcome): void {
    if (outcome.kind === 'challenge') {
      const eapRequest = eapPacketFromWireHex(outcome.eapMessageHex);
      if (!eapRequest) { this.finishAuth(rt, false, identity, 'radius-reject'); return; }
      rt.radiusState = outcome.state;
      rt.pendingEapId = eapRequest.identifier;
      this.sendEapol(rt, 'eap-packet', eapRequest); // relay the server's EAP-Request/MD5-Challenge to the supplicant
      return;
    }
    if (outcome.kind === 'accept') {
      this.finishAuth(rt, true, identity, 'radius-accept', parseAuthorization(outcome.attributes));
      return;
    }
    this.finishAuth(rt, false, identity, 'radius-reject');
  }

  private finishAuth(
    rt: Dot1xPortRuntime, accepted: boolean, identity: string,
    reason: 'local-accept' | 'local-reject-unknown-user' | 'local-reject-bad-password' | 'radius-accept' | 'radius-reject',
    authorization?: RadiusAuthorization,
  ): void {
    rt.radiusState = null;
    this.getBus().publish({
      topic: 'dot1x.auth.outcome',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: rt.port, identity, accepted, reason,
        vlanId: authorization?.vlanId, sessionTimeoutSec: authorization?.sessionTimeoutSec,
      },
    });
    const successOrFailure: EapPacket = {
      type: 'eap', code: accepted ? 'success' : 'failure',
      identifier: (rt.pendingEapId ?? 0),
    };
    this.sendEapol(rt, 'eap-packet', successOrFailure);
    if (accepted) {
      this.transition(rt, 'authorized', 'auth-success');
      if (authorization?.vlanId !== undefined) this.host.onDot1xVlanAssigned?.(rt.port, authorization.vlanId);
    } else {
      rt.reauthCount++;
      if (rt.reauthCount >= rt.maxReauthReq) {
        rt.holdUntilMs = Date.now() + rt.holdMs;
        this.transition(rt, 'held', 'auth-failure');
      } else {
        this.transition(rt, 'unauthorized', 'auth-failure');
      }
    }
  }

  private sendEapol(rt: Dot1xPortRuntime, packetType: EapolPacket['packetType'], eap?: EapPacket): void {
    const port = this.host.getPort(rt.port);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const payload: EapolPacket = {
      type: 'eapol', version: 2, packetType, eap,
    };
    const dst = rt.lastSupplicantMac
      ? new MACAddress(rt.lastSupplicantMac)
      : new MACAddress(EAPOL_PAE_GROUP_MAC);
    this.host.sendOnLink({
      iface: rt.port,
      destination: dst,
      etherType: ETHERTYPE_EAPOL,
      payload,
    });
    this.getBus().publish({
      topic: 'dot1x.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: rt.port, packetType, eapCode: eap?.code,
      },
    });
  }

  private transition(rt: Dot1xPortRuntime, newState: Dot1xPortState,
                     reason: 'config' | 'eapol-start' | 'eap-response' | 'auth-success' | 'auth-failure' | 'eapol-logoff' | 'hold-expired' | 'link'): void {
    if (rt.state === newState) return;
    const oldState = rt.state;
    rt.state = newState;
    rt.lastTransitionMs = Date.now();
    this.getBus().publish({
      topic: 'dot1x.port.state.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: rt.port, oldState, newState, mode: rt.mode, reason,
      },
    });
    Logger.info(this.host.id, 'dot1x:port',
      `${this.host.name}: ${rt.port} ${oldState} → ${newState} (${reason})`);
    if (this.host.onDot1xPortAuthorized) {
      this.host.onDot1xPortAuthorized(rt.port, isAuthorizedState(newState));
    }
    this.armOrClearHeldTimer(rt);
  }

  /**
   * Quiet-period timer (IEEE 802.1X-2004 §8.2 held state): after the
   * authenticator fails a supplicant `maxReauthReq` times it stays in
   * `held` for `holdMs`, then the port returns to `unauthorized` so the
   * supplicant may try again. Previously the port left `held` only if a
   * new EAPOL-Start happened to arrive — it could be wedged indefinitely.
   */
  private armOrClearHeldTimer(rt: Dot1xPortRuntime): void {
    const existing = this.heldTimers.get(rt.port);
    if (existing) { this.timers.clear(existing); this.heldTimers.delete(rt.port); }
    if (rt.state !== 'held') return;
    const handle = this.timers.setTimeout(() => {
      this.heldTimers.delete(rt.port);
      rt.reauthCount = 0;
      rt.holdUntilMs = 0;
      this.transition(rt, 'unauthorized', 'hold-expired');
    }, rt.holdMs);
    this.heldTimers.set(rt.port, handle);
  }

  private ensurePort(portName: string, mode: Dot1xPortMode): Dot1xPortRuntime {
    let rt = this.config.ports.get(portName);
    if (!rt) {
      rt = defaultPortRuntime(portName, mode);
      rt.maxReauthReq = this.config.defaultMaxReauthReq;
      rt.holdMs = this.config.defaultHoldMs;
      this.config.ports.set(portName, rt);
    }
    return rt;
  }
}
