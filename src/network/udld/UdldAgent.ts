import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { ReactiveAgentBase } from '../core/ReactiveAgentBase';
import {
  type UdldConfig, type UdldPortRuntime, type UdldPortStateName,
  type UdldPacket, type UdldEchoEntry, type UdldNeighborEntry, type UdldMode,
  createDefaultUdldConfig, defaultPortRuntime, neighborKey,
  ETHERTYPE_UDLD, UDLD_MULTICAST_MAC,
} from './types';
import {
  MACAddress,
  type EthernetFrame,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface UdldHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  onUdldErrDisable?(portName: string): void;
}

export class UdldAgent extends ReactiveAgentBase {
  private config: UdldConfig = createDefaultUdldConfig();
  private readonly neighbors = new Map<string, UdldNeighborEntry>();

  constructor(
    private readonly host: UdldHost,
    getBus: () => IEventBus,
    getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    super(host, getBus, getScheduler);
  }

  getConfig(): Readonly<UdldConfig> { return this.config; }

  setEnabled(on: boolean): void {
    if (this.config.enabled === on) return;
    this.config.enabled = on;
    if (on) this.armTimers();
    else this.stopTimers();
  }

  setGlobalMode(mode: UdldMode): void {
    this.config.globalMode = mode;
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      const rt = this.config.ports.get(name);
      if (!rt || rt.mode === 'disabled') {
        const next = mode === 'disabled' ? 'disabled' : mode;
        this.ensurePort(name, next);
      }
    }
  }

  setPortMode(portName: string, mode: UdldMode): void {
    const rt = this.ensurePort(portName, mode);
    rt.mode = mode;
    if (mode === 'disabled') {
      this.transition(rt, 'shutdown', 'config');
      this.clearNeighborsFor(portName);
      return;
    }
    if (rt.state === 'shutdown' || rt.state === 'err-disable') {
      this.transition(rt, 'unknown', 'config');
    }
    this.transmit(portName, 'probe');
  }

  getPortRuntime(portName: string): UdldPortRuntime | undefined {
    return this.config.ports.get(portName);
  }

  listPorts(): UdldPortRuntime[] {
    return Array.from(this.config.ports.values())
      .sort((a, b) => a.port.localeCompare(b.port));
  }

  getNeighborsFor(portName: string): UdldNeighborEntry[] {
    return Array.from(this.neighbors.values()).filter(n => n.localPort === portName);
  }

  listNeighbors(): UdldNeighborEntry[] {
    return Array.from(this.neighbors.values());
  }

  reset(portName: string): void {
    const rt = this.config.ports.get(portName);
    if (!rt) return;
    rt.retries = 0;
    this.transition(rt, 'unknown', 'reset');
    this.clearNeighborsFor(portName);
  }

  handleFrame(portName: string, frame: EthernetFrame): void {
    if (!this.config.enabled) return;
    if (frame.etherType !== ETHERTYPE_UDLD) return;
    const rt = this.config.ports.get(portName);
    if (!rt || rt.mode === 'disabled') return;
    const payload = frame.payload as UdldPacket | undefined;
    if (!payload || payload.type !== 'udld') return;

    this.getBus().publish({
      topic: 'udld.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName,
        fromDeviceId: payload.senderDeviceId,
        fromPortId: payload.senderPortId,
        opcode: payload.opcode,
      },
    });

    if (payload.opcode === 'flush') {
      this.clearNeighborsFor(portName);
      this.transition(rt, 'unknown', 'peer');
      return;
    }

    const key = neighborKey(portName, payload.senderDeviceId, payload.senderPortId);
    const had = this.neighbors.has(key);
    const entry: UdldNeighborEntry = {
      localPort: portName,
      remoteDeviceId: payload.senderDeviceId,
      remotePortId: payload.senderPortId,
      remoteHostname: payload.senderHostname,
      lastHeardMs: Date.now(),
      helloIntervalSec: payload.helloIntervalSec,
      echo: payload.echo.slice(),
    };
    this.neighbors.set(key, entry);
    if (!had) {
      this.getBus().publish({
        topic: 'udld.neighbor.changed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: portName,
          remoteDeviceId: payload.senderDeviceId,
          remotePortId: payload.senderPortId,
          added: true,
        },
      });
    }

    const echoesUs = payload.echo.some(e =>
      e.deviceId === this.host.id && e.portId === portName);
    if (echoesUs) {
      rt.retries = 0;
      if (rt.state !== 'bidirectional') {
        this.transition(rt, 'bidirectional', 'echo');
        this.kickEcho(portName);
      }
    } else if (payload.opcode === 'probe' && !had) {
      this.kickEcho(portName);
    }
  }

  private ensurePort(portName: string, mode: UdldMode): UdldPortRuntime {
    let rt = this.config.ports.get(portName);
    if (!rt) {
      rt = defaultPortRuntime(portName, mode);
      this.config.ports.set(portName, rt);
    }
    return rt;
  }

  private transition(rt: UdldPortRuntime, newState: UdldPortStateName,
                     reason: 'config' | 'peer' | 'timeout' | 'link' | 'echo' | 'reset'): void {
    if (rt.state === newState) return;
    const oldState = rt.state;
    rt.state = newState;
    rt.lastTransitionMs = Date.now();
    this.getBus().publish({
      topic: 'udld.state.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: rt.port, oldState, newState, mode: rt.mode, reason,
      },
    });
    Logger.info(this.host.id, 'udld:state',
      `${this.host.name}: ${rt.port} ${oldState} → ${newState}`);
  }

  private clearNeighborsFor(portName: string): void {
    for (const [k, v] of this.neighbors) {
      if (v.localPort === portName) {
        this.neighbors.delete(k);
        this.getBus().publish({
          topic: 'udld.neighbor.changed',
          payload: {
            deviceId: this.host.id, hostname: this.host.getHostname(),
            port: portName,
            remoteDeviceId: v.remoteDeviceId,
            remotePortId: v.remotePortId,
            added: false,
          },
        });
      }
    }
  }

  private kickEcho(portName: string): void {
    this.transmit(portName, 'echo');
  }

  private transmit(portName: string, opcode: 'probe' | 'echo'): void {
    const rt = this.config.ports.get(portName);
    if (!rt || rt.mode === 'disabled') return;
    if (rt.state === 'err-disable' || rt.state === 'shutdown') return;
    const port = this.host.getPort(portName);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const echo: UdldEchoEntry[] = this.getNeighborsFor(portName).map(n => ({
      deviceId: n.remoteDeviceId, portId: n.remotePortId,
    }));
    const payload: UdldPacket = {
      type: 'udld', version: 1, opcode,
      senderDeviceId: this.host.id,
      senderPortId: portName,
      senderHostname: this.host.getHostname(),
      helloIntervalSec: this.config.helloIntervalSec,
      messageInterval: this.config.helloIntervalSec,
      timeoutInterval: this.config.messageTimeoutSec,
      echo,
    };
    const frame: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: new MACAddress(UDLD_MULTICAST_MAC),
      etherType: ETHERTYPE_UDLD,
      payload,
    };
    this.host.sendFrame(portName, frame);
    this.getBus().publish({
      topic: 'udld.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, opcode, echoCount: echo.length,
      },
    });
  }

  private transmitFlush(portName: string): void {
    const port = this.host.getPort(portName);
    if (!port) return;
    const payload: UdldPacket = {
      type: 'udld', version: 1, opcode: 'flush',
      senderDeviceId: this.host.id,
      senderPortId: portName,
      senderHostname: this.host.getHostname(),
      helloIntervalSec: this.config.helloIntervalSec,
      messageInterval: this.config.helloIntervalSec,
      timeoutInterval: this.config.messageTimeoutSec,
      echo: [],
    };
    const frame: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: new MACAddress(UDLD_MULTICAST_MAC),
      etherType: ETHERTYPE_UDLD,
      payload,
    };
    this.host.sendFrame(portName, frame);
  }

  protected isEnabled(): boolean { return this.config.enabled; }

  protected armTimers(): void {
    this.scheduleInterval('hello', () => {
      for (const rt of this.config.ports.values()) {
        if (rt.mode === 'disabled') continue;
        this.transmit(rt.port, 'probe');
      }
    }, this.config.helloIntervalSec * 1000);
    this.scheduleInterval('expiry', () => this.expireDue(), 1000);
    for (const rt of this.config.ports.values()) {
      if (rt.mode !== 'disabled') this.transmit(rt.port, 'probe');
    }
  }

  private expireDue(): void {
    const now = Date.now();
    const stale: string[] = [];
    for (const [k, n] of this.neighbors) {
      const timeoutMs = this.config.messageTimeoutSec * 1000;
      if (now - n.lastHeardMs > timeoutMs) stale.push(k);
    }
    for (const k of stale) {
      const n = this.neighbors.get(k)!;
      this.neighbors.delete(k);
      this.getBus().publish({
        topic: 'udld.neighbor.changed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: n.localPort,
          remoteDeviceId: n.remoteDeviceId,
          remotePortId: n.remotePortId,
          added: false,
        },
      });
      const rt = this.config.ports.get(n.localPort);
      if (!rt) continue;
      if (rt.mode === 'aggressive') {
        rt.retries++;
        if (rt.retries >= this.config.aggressiveRetryLimit) {
          this.transition(rt, 'err-disable', 'timeout');
          this.getBus().publish({
            topic: 'udld.err-disable',
            payload: {
              deviceId: this.host.id, hostname: this.host.getHostname(),
              port: rt.port, reason: 'aggressive-timeout',
            },
          });
          if (this.host.onUdldErrDisable) this.host.onUdldErrDisable(rt.port);
        }
      } else {
        if (rt.state === 'bidirectional') this.transition(rt, 'unidirectional', 'timeout');
      }
    }
  }

  protected override onPortLinkUp(portName: string): void {
    const rt = this.config.ports.get(portName);
    if (!rt || rt.mode === 'disabled') return;
    if (rt.state === 'err-disable') return;
    rt.retries = 0;
    this.transition(rt, 'unknown', 'link');
    this.transmit(portName, 'probe');
  }

  protected override onPortLinkDown(portName: string): void {
    const rt = this.config.ports.get(portName);
    if (!rt) return;
    if (rt.state === 'err-disable') return;
    if (rt.mode === 'disabled') return;
    this.transmitFlush(portName);
    this.clearNeighborsFor(portName);
    this.transition(rt, 'unknown', 'link');
  }
}
