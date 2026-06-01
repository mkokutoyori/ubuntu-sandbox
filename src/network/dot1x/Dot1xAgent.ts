import type { IEventBus } from '@/events/EventBus';
import {
  type Dot1xConfig, type Dot1xPortRuntime, type Dot1xPortMode, type Dot1xPortState,
  type EapolPacket, type EapPacket,
  createDefaultDot1xConfig, defaultPortRuntime, isAuthorizedState,
  ETHERTYPE_EAPOL, EAPOL_PAE_GROUP_MAC,
} from './types';
import {
  MACAddress,
  type EthernetFrame,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface Dot1xRadiusBackend {
  authenticate(username: string, password: string): Promise<boolean>;
}

export interface Dot1xHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  onDot1xPortAuthorized?(portName: string, authorized: boolean): void;
}

export class Dot1xAgent {
  private config: Dot1xConfig = createDefaultDot1xConfig();
  private radius: Dot1xRadiusBackend | null = null;
  private running = false;
  private nextEapId = 1;

  constructor(
    private readonly host: Dot1xHost,
    private readonly getBus: () => IEventBus,
  ) {}

  start(): void { if (!this.running) this.running = true; }
  stop(): void { this.running = false; }

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

  addLocalUser(username: string, password: string): void {
    this.config.localUsers.set(username, { username, password });
  }

  removeLocalUser(username: string): void { this.config.localUsers.delete(username); }

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
      this.transition(rt, 'authenticating', 'eap-response');
      this.verifyIdentity(rt, identity);
    }
  }

  private verifyIdentity(rt: Dot1xPortRuntime, identity: string): void {
    const local = this.config.localUsers.get(identity);
    const handle = (accepted: boolean,
                    reason: 'local-accept' | 'local-reject-unknown-user' | 'local-reject-bad-password' | 'radius-accept' | 'radius-reject') => {
      this.getBus().publish({
        topic: 'dot1x.auth.outcome',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: rt.port, identity, accepted, reason,
        },
      });
      const successOrFailure: EapPacket = {
        type: 'eap', code: accepted ? 'success' : 'failure',
        identifier: (rt.pendingEapId ?? 0),
      };
      this.sendEapol(rt, 'eap-packet', successOrFailure);
      if (accepted) {
        this.transition(rt, 'authorized', 'auth-success');
      } else {
        rt.reauthCount++;
        if (rt.reauthCount >= rt.maxReauthReq) {
          rt.holdUntilMs = Date.now() + rt.holdMs;
          this.transition(rt, 'held', 'auth-failure');
        } else {
          this.transition(rt, 'unauthorized', 'auth-failure');
        }
      }
    };

    if (local) {
      handle(true, 'local-accept');
      return;
    }
    if (this.radius) {
      const promise = this.radius.authenticate(identity, '');
      promise.then((accepted) => handle(accepted, accepted ? 'radius-accept' : 'radius-reject'))
             .catch(() => handle(false, 'radius-reject'));
      return;
    }
    handle(false, 'local-reject-unknown-user');
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
    const frame: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: dst,
      etherType: ETHERTYPE_EAPOL,
      payload,
    };
    this.host.sendFrame(rt.port, frame);
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
