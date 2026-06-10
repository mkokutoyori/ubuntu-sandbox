import { DeviceType, EthernetFrame } from '../core/types';
import { Switch, STPPortState } from './Switch';
import type { ISwitchShell } from './shells/ISwitchShell';
import { HuaweiSwitchShell } from './shells/HuaweiSwitchShell';
import { LldpAgent, type LldpNeighbor } from '../lldp/LldpAgent';
import { ETHERTYPE_LLDP } from '../lldp/types';
import { StpAgent, type StpForwardState } from '../stp/StpAgent';
import { ETHERTYPE_STP } from '../stp/types';
import { LacpAgent } from '../lacp/LacpAgent';
import { ETHERTYPE_LACP } from '../lacp/types';
import { IgmpSnoopingAgent } from '../igmp-snooping/IgmpSnoopingAgent';
import type { NeighborDTO } from './inspection/DeviceStateView';
import type { IEventBus } from '@/events/EventBus';

export class HuaweiSwitch extends Switch {
  private readonly lldpAgent: LldpAgent;
  private readonly stpAgent: StpAgent;
  private readonly lacpAgent: LacpAgent;
  private readonly igmpSnoopingAgent: IgmpSnoopingAgent;

  constructor(type: DeviceType = 'switch-huawei', name: string = 'Switch', portCount: number = 50, x: number = 0, y: number = 0) {
    super(type, name, portCount, x, y);
    const hostBase = {
      id: this.id, name: this.name,
      getHostname: () => this.getHostname(),
      getType: () => this.getType(),
      getPort: (n: string) => this.getPort(n),
      getPorts: () => this.getPorts(),
      sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
    };
    this.lldpAgent = new LldpAgent(hostBase, () => this.getBus());
    const firstPort = this.getPorts()[0];
    const baseMac = firstPort ? firstPort.getMAC().toString() : '00:00:00:00:00:00';
    this.stpAgent = new StpAgent({
      ...hostBase,
      onForwardStateChanged: (p, s) => this.applyStpForwardState(p, s),
    }, () => this.getBus(), baseMac);
    this.lacpAgent = new LacpAgent(hostBase, () => this.getBus(), baseMac);
    this.igmpSnoopingAgent = new IgmpSnoopingAgent({
      ...hostBase,
      resolveIngressVlan: (p: string) => this.resolveSnoopingVlan(p),
      isTrunkPort: (p: string) => this._vtpIsTrunkPort(p),
    }, () => this.getBus());
    this.lldpAgent.start();
    this.stpAgent.start();
    this.lacpAgent.start();
    this.igmpSnoopingAgent.start();
  }

  private resolveSnoopingVlan(portName: string): number | undefined {
    const cfg = this.getSwitchportConfig(portName);
    if (!cfg) return undefined;
    if (cfg.mode === 'access') return cfg.accessVlan;
    if (cfg.mode === 'trunk') return cfg.trunkNativeVlan;
    return undefined;
  }

  private applyStpForwardState(portName: string, state: StpForwardState): void {
    if (state === 'forwarding') this.setSTPState(portName, 'forwarding');
    else if (state === 'blocking') this.setSTPState(portName, 'blocking');
    else this.setSTPState(portName, 'disabled');
  }

  override setEventBus(bus: IEventBus | null): void {
    super.setEventBus(bus);
    if (this.lldpAgent) { this.lldpAgent.stop(); this.lldpAgent.start(); }
    if (this.stpAgent) { this.stpAgent.stop(); this.stpAgent.start(); }
    if (this.lacpAgent) { this.lacpAgent.stop(); this.lacpAgent.start(); }
    if (this.igmpSnoopingAgent) { this.igmpSnoopingAgent.stop(); this.igmpSnoopingAgent.start(); }
  }

  protected override handleFrame(portName: string, frame: EthernetFrame): void {
    if (frame.etherType === ETHERTYPE_LLDP) {
      this.lldpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === ETHERTYPE_STP) {
      this.stpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === ETHERTYPE_LACP) {
      this.lacpAgent.handleFrame(portName, frame);
      return;
    }
    this.igmpSnoopingAgent.handleFrame(portName, frame);
    super.handleFrame(portName, frame);
  }

  protected override getIgmpSnoopingAgentOrNull(): IgmpSnoopingAgent {
    return this.igmpSnoopingAgent;
  }

  getLldpAgent(): LldpAgent { return this.lldpAgent; }
  getLldpNeighbors(): NeighborDTO[] { return lldpToNeighborDTO(this.lldpAgent.getNeighbors()); }
  getStpAgent(): StpAgent { return this.stpAgent; }
  getLacpAgent(): LacpAgent { return this.lacpAgent; }
  getIgmpSnoopingAgent(): IgmpSnoopingAgent { return this.igmpSnoopingAgent; }

  protected getPortName(index: number, _total: number): string {
    return `GigabitEthernet0/0/${index}`;
  }

  protected getInitialSTPState(): STPPortState {
    return 'listening';
  }

  protected createShell(): ISwitchShell {
    return new HuaweiSwitchShell();
  }

  protected onVlanDeleted(_vlanId: number, affectedPorts: string[]): void {
    const defaultVlan = this.vlans.get(1);
    for (const portName of affectedPorts) {
      const cfg = this._getSwitchportConfigs().get(portName);
      if (cfg) cfg.accessVlan = 1;
      if (defaultVlan) defaultVlan.ports.add(portName);
      this.portVlanStates.set(portName, 'active');
    }
  }

  protected onVlanRecreated(_vlanId: number): string[] {
    return [];
  }

  getOSType(): string { return 'huawei-vrp'; }

  getBootSequence(): string {
    return [
      '',
      `Huawei Versatile Routing Platform Software`,
      `VRP (R) software, Version 5.170 (S5720 V200R019C10SPC500)`,
      `Copyright (C) 2000-2025 HUAWEI TECH CO., LTD`,
      '',
      `${this.hostname} with ${this.getPortNames().length} GigabitEthernet interfaces`,
      `Base ethernet MAC address: ${this.getPort(this.getPortNames()[0])?.getMAC() || '00:00:00:00:00:00'}`,
      '',
      'Press ENTER to get started.',
    ].join('\n');
  }
}

function lldpToNeighborDTO(rows: readonly LldpNeighbor[]): NeighborDTO[] {
  return rows.map(n => ({
    localPort: n.localPort,
    remoteHost: n.systemName,
    remotePort: n.portId,
    remoteType: n.remoteType,
    remotePlatform: n.systemDescription.split(',')[0] ?? n.systemDescription,
    remoteCapability: n.remoteCapabilities[0] === 'Router' ? 'Router'
      : n.remoteCapabilities[0] === 'Bridge' ? 'Switch' : 'Host',
  }));
}
