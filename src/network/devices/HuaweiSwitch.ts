import { DeviceType, EthernetFrame, ETHERTYPE_IPV4, type IPv4Packet, IPAddress } from '../core/types';
import { AgentRegistry } from './AgentRegistry';
import { lldpToNeighborDTO } from './inspection/neighborConverters';
import { Switch, STPPortState } from './Switch';
import type { ISwitchShell } from './shells/ISwitchShell';
import { HuaweiSwitchShell } from './shells/HuaweiSwitchShell';
import { NATEngine } from './router/NATEngine';
import { LldpAgent } from '../lldp/LldpAgent';
import { ETHERTYPE_LLDP } from '../lldp/types';
import { StpAgent, type StpForwardState } from '../stp/StpAgent';
import { ETHERTYPE_STP } from '../stp/types';
import { LacpAgent } from '../lacp/LacpAgent';
import { ETHERTYPE_LACP } from '../lacp/types';
import { IgmpSnoopingAgent } from '../igmp-snooping/IgmpSnoopingAgent';
import { Dot1xAgent } from '../dot1x/Dot1xAgent';
import { ETHERTYPE_EAPOL } from '../dot1x/types';
import type { NeighborDTO } from './inspection/DeviceStateView';
import type { IEventBus } from '@/events/EventBus';

export class HuaweiSwitch extends Switch {
  private readonly agents = new AgentRegistry();
  private readonly lldpAgent: LldpAgent;
  private readonly stpAgent: StpAgent;
  private readonly lacpAgent: LacpAgent;
  private readonly igmpSnoopingAgent: IgmpSnoopingAgent;
  private readonly dot1xAgent: Dot1xAgent;
  private readonly natEngine = new NATEngine();
  _getNATEngine(): NATEngine { return this.natEngine; }

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
      onForwardStateChanged: (p, s, v) => this.applyStpForwardState(p, s, v),
      onTopologyChangeAging: (sec) => this._setStpFastAging(sec),
    }, () => this.getBus(), baseMac);
    this.lacpAgent = new LacpAgent(hostBase, () => this.getBus(), baseMac);
    this.igmpSnoopingAgent = new IgmpSnoopingAgent({
      ...hostBase,
      resolveIngressVlan: (p: string) => this.resolveSnoopingVlan(p),
      isTrunkPort: (p: string) => this._vtpIsTrunkPort(p),
    }, () => this.getBus());
    this.dot1xAgent = new Dot1xAgent({
      ...hostBase,
      onDot1xPortAuthorized: (p, authorized) => this.applyDot1xAuth(p, authorized),
    }, () => this.getBus());
    this.agents.registerAll(
      this.lldpAgent, this.stpAgent, this.lacpAgent, this.igmpSnoopingAgent,
      this.dot1xAgent,
    );
    this.agents.startAll();
  }

  private applyDot1xAuth(portName: string, authorized: boolean): void {
    if (!authorized) this.flushDynamicMacsOnPort(portName, 'dot1x-unauthorized');
  }

  private applyStpForwardState(portName: string, state: StpForwardState, vlan: number): void {
    this.setStpVlanState(portName, vlan, state);
  }

  override setEventBus(bus: IEventBus | null): void {
    super.setEventBus(bus);
    // Re-bind every agent's subscriptions to the newly injected bus.
    // (setEventBus can fire from the base constructor, before the registry
    // field initializer ran — hence the optional chain.)
    this.agents?.restartAll();
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
    if (frame.etherType === ETHERTYPE_EAPOL) {
      this.dot1xAgent.handleFrame(portName, frame);
      return;
    }
    if (!this.dot1xAgent.isPortAuthorized(portName)) {
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
  getDot1xAgent(): Dot1xAgent { return this.dot1xAgent; }

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
