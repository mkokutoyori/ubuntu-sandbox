/**
 * CiscoSwitch - Cisco Catalyst Layer 2 Switch
 *
 * Cisco-specific behaviors:
 *   - Port naming: FastEthernet0/X (first 24), GigabitEthernet0/X (25+)
 *   - STP: PortFast enabled by default → ports start in forwarding state
 *   - VLAN deletion: access ports become suspended/inactive
 *     They don't forward traffic until the VLAN is recreated.
 *   - VLAN recreation: suspended ports are reactivated automatically
 *   - CLI: CiscoSwitchShell (IOS-style user/privileged/config modes)
 *   - Boot: Cisco IOS C2960 format
 */

import { DeviceType, EthernetFrame, ETHERTYPE_IPV4, IPv4Packet, IPAddress } from '../core/types';
import { Switch, STPPortState } from './Switch';
import type { ISwitchShell } from './shells/ISwitchShell';
import { CiscoSwitchShell } from './shells/CiscoSwitchShell';
import { CdpAgent, type CdpNeighbor } from '../cdp/CdpAgent';
import { ETHERTYPE_CDP } from '../cdp/types';
import { LldpAgent, type LldpNeighbor } from '../lldp/LldpAgent';
import { ETHERTYPE_LLDP } from '../lldp/types';
import { DtpAgent } from '../dtp/DtpAgent';
import { ETHERTYPE_DTP, type DtpOperationalMode } from '../dtp/types';
import { StpAgent, type StpForwardState } from '../stp/StpAgent';
import { ETHERTYPE_STP } from '../stp/types';
import { LacpAgent } from '../lacp/LacpAgent';
import { ETHERTYPE_LACP } from '../lacp/types';
import { VtpAgent } from '../vtp/VtpAgent';
import { ETHERTYPE_VTP } from '../vtp/types';
import { UdldAgent } from '../udld/UdldAgent';
import { ETHERTYPE_UDLD } from '../udld/types';
import { IgmpSnoopingAgent } from '../igmp-snooping/IgmpSnoopingAgent';
import { SyslogAgent } from '../syslog/SyslogAgent';
import { Dot1xAgent } from '../dot1x/Dot1xAgent';
import { ETHERTYPE_EAPOL } from '../dot1x/types';
import type { NeighborDTO } from './inspection/DeviceStateView';
import type { IEventBus } from '@/events/EventBus';

export class CiscoSwitch extends Switch {
  private readonly cdpAgent: CdpAgent;
  private readonly lldpAgent: LldpAgent;
  private readonly dtpAgent: DtpAgent;
  private readonly stpAgent: StpAgent;
  private readonly lacpAgent: LacpAgent;
  private readonly vtpAgent: VtpAgent;
  private readonly udldAgent: UdldAgent;
  private readonly igmpSnoopingAgent: IgmpSnoopingAgent;
  private readonly syslogAgent: SyslogAgent;
  private readonly dot1xAgent: Dot1xAgent;

  constructor(type: DeviceType = 'switch-cisco', name: string = 'Switch', portCount: number = 50, x: number = 0, y: number = 0) {
    super(type, name, portCount, x, y);
    const hostBase = {
      id: this.id, name: this.name,
      getHostname: () => this.getHostname(),
      getType: () => this.getType(),
      getPort: (n: string) => this.getPort(n),
      getPorts: () => this.getPorts(),
      sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
    };
    this.cdpAgent = new CdpAgent({
      ...hostBase,
      getNativeVlan: (p: string) => this.getSwitchportConfig(p)?.accessVlan,
    }, () => this.getBus());
    this.lldpAgent = new LldpAgent(hostBase, () => this.getBus());
    this.dtpAgent = new DtpAgent({
      ...hostBase,
      onOperationalModeChanged: (p, m) => this.applyDtpOperationalMode(p, m),
    }, () => this.getBus());
    const firstPort = this.getPorts()[0];
    const baseMac = firstPort ? firstPort.getMAC().toString() : '00:00:00:00:00:00';
    this.stpAgent = new StpAgent({
      ...hostBase,
      onForwardStateChanged: (p, s) => this.applyStpForwardState(p, s),
      onStpBpduGuardErrDisable: (p) => this.applyStpBpduGuardErrDisable(p),
    }, () => this.getBus(), baseMac);
    this.lacpAgent = new LacpAgent(hostBase, () => this.getBus(), baseMac);
    this.vtpAgent = new VtpAgent({
      ...hostBase,
      vtpListVlans: () => this._vtpListVlans(),
      vtpApplyVlans: (vs) => this._vtpApplyVlans(vs),
      vtpIsTrunkPort: (n) => this._vtpIsTrunkPort(n),
    }, () => this.getBus(), baseMac);
    this.udldAgent = new UdldAgent({
      ...hostBase,
      onUdldErrDisable: (p: string) => this.applyUdldErrDisable(p),
    }, () => this.getBus());
    this.igmpSnoopingAgent = new IgmpSnoopingAgent({
      ...hostBase,
      resolveIngressVlan: (p: string) => this.resolveSnoopingVlan(p),
      isTrunkPort: (p: string) => this._vtpIsTrunkPort(p),
    }, () => this.getBus());
    this.syslogAgent = new SyslogAgent(hostBase, () => this.getBus());
    this.dot1xAgent = new Dot1xAgent({
      ...hostBase,
      onDot1xPortAuthorized: (p, authorized) => this.applyDot1xAuth(p, authorized),
    }, () => this.getBus());
    this.cdpAgent.start();
    this.lldpAgent.start();
    this.dtpAgent.start();
    this.stpAgent.start();
    this.lacpAgent.start();
    this.vtpAgent.start();
    this.udldAgent.start();
    this.igmpSnoopingAgent.start();
    this.syslogAgent.start();
    this.dot1xAgent.start();
  }

  private applyDot1xAuth(_portName: string, _authorized: boolean): void {
    void _portName; void _authorized;
  }

  private resolveSnoopingVlan(portName: string): number | undefined {
    const cfg = this.getSwitchportConfig(portName);
    if (!cfg) return undefined;
    if (cfg.mode === 'access') return cfg.accessVlan;
    if (cfg.mode === 'trunk') return cfg.trunkNativeVlan;
    return undefined;
  }

  private applyUdldErrDisable(portName: string): void {
    const p = this.getPort(portName);
    if (p) p.setUp(false);
  }

  private applyDtpOperationalMode(portName: string, mode: DtpOperationalMode): void {
    const cfg = this.getSwitchportConfig(portName);
    if (!cfg) return;
    if (cfg.mode === mode) return;
    super.setSwitchportMode(portName, mode);
  }

  private applyStpForwardState(portName: string, state: StpForwardState): void {
    // StpForwardState is a subset of STPPortState — apply verbatim so the
    // data plane honors the 802.1D listening/learning transitions.
    this.setSTPState(portName, state);
  }

  private applyStpBpduGuardErrDisable(portName: string): void {
    const p = this.getPort(portName);
    if (p) p.setUp(false);
    this.setSTPState(portName, 'disabled');
  }

  override setEventBus(bus: IEventBus | null): void {
    super.setEventBus(bus);
    if (this.cdpAgent) { this.cdpAgent.stop(); this.cdpAgent.start(); }
    if (this.lldpAgent) { this.lldpAgent.stop(); this.lldpAgent.start(); }
    if (this.dtpAgent) { this.dtpAgent.stop(); this.dtpAgent.start(); }
    if (this.stpAgent) { this.stpAgent.stop(); this.stpAgent.start(); }
    if (this.lacpAgent) { this.lacpAgent.stop(); this.lacpAgent.start(); }
    if (this.vtpAgent) { this.vtpAgent.stop(); this.vtpAgent.start(); }
    if (this.udldAgent) { this.udldAgent.stop(); this.udldAgent.start(); }
    if (this.igmpSnoopingAgent) { this.igmpSnoopingAgent.stop(); this.igmpSnoopingAgent.start(); }
    if (this.syslogAgent) { this.syslogAgent.stop(); this.syslogAgent.start(); }
    if (this.dot1xAgent) { this.dot1xAgent.stop(); this.dot1xAgent.start(); }
  }

  protected override handleFrame(portName: string, frame: EthernetFrame): void {
    if (frame.etherType === ETHERTYPE_CDP) {
      this.cdpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === ETHERTYPE_LLDP) {
      this.lldpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === ETHERTYPE_DTP) {
      this.dtpAgent.handleFrame(portName, frame);
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
    if (frame.etherType === ETHERTYPE_VTP) {
      this.vtpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === ETHERTYPE_UDLD) {
      this.udldAgent.handleFrame(portName, frame);
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

  protected override resolveSnoopedMulticastEgressPorts(ingressPort: string, frame: EthernetFrame, vlan: number): string[] | null {
    if (frame.etherType !== ETHERTYPE_IPV4) return null;
    const ipPkt = frame.payload as IPv4Packet | undefined;
    if (!ipPkt || ipPkt.type !== 'ipv4' || !(ipPkt.destinationIP instanceof IPAddress)) return null;
    const firstOctet = ipPkt.destinationIP.getOctets()[0];
    if (firstOctet < 224 || firstOctet > 239) return null;
    const vlanState = this.igmpSnoopingAgent.getVlanState(vlan);
    if (!vlanState || !vlanState.enabled) return null;
    const ports = this.igmpSnoopingAgent.computeEgressPorts(ingressPort, ipPkt.destinationIP.toString());
    return ports.length > 0 ? ports : null;
  }

  getDtpAgent(): DtpAgent { return this.dtpAgent; }
  getStpAgent(): StpAgent { return this.stpAgent; }
  getLacpAgent(): LacpAgent { return this.lacpAgent; }
  getVtpAgent(): VtpAgent { return this.vtpAgent; }
  getUdldAgent(): UdldAgent { return this.udldAgent; }
  getIgmpSnoopingAgent(): IgmpSnoopingAgent { return this.igmpSnoopingAgent; }
  getSyslogAgent(): SyslogAgent { return this.syslogAgent; }
  getDot1xAgent(): Dot1xAgent { return this.dot1xAgent; }

  override setSwitchportMode(portName: string, mode: 'access' | 'trunk'): boolean {
    const r = super.setSwitchportMode(portName, mode);
    if (r) this.dtpAgent.setAdminMode(portName, mode);
    return r;
  }

  getCdpAgent(): CdpAgent { return this.cdpAgent; }
  getCdpNeighbors(): NeighborDTO[] { return cdpToNeighborDTO(this.cdpAgent.getNeighbors()); }
  getLldpAgent(): LldpAgent { return this.lldpAgent; }
  getLldpNeighbors(): NeighborDTO[] { return lldpToNeighborDTO(this.lldpAgent.getNeighbors()); }

  // ─── Vendor Hooks ──────────────────────────────────────────────

  protected getPortName(index: number, total: number): string {
    return index < 24
      ? `FastEthernet0/${index}`
      : `GigabitEthernet0/${index - 24}`;
  }

  protected getInitialSTPState(): STPPortState {
    // Cisco PortFast: ports start forwarding immediately
    return 'forwarding';
  }

  protected createShell(): ISwitchShell {
    return new CiscoSwitchShell();
  }

  /**
   * Cisco VLAN deletion behavior:
   * Access ports assigned to a deleted VLAN become suspended/inactive.
   * They remain assigned to the (now non-existent) VLAN but stop forwarding
   * traffic. This is the documented Cisco IOS/Catalyst behavior.
   */
  protected onVlanDeleted(vlanId: number, affectedPorts: string[]): void {
    for (const portName of affectedPorts) {
      this.portVlanStates.set(portName, 'suspended');
    }
  }

  /**
   * Cisco VLAN recreation behavior:
   * When a VLAN is recreated, any ports that were suspended because
   * they were assigned to that VLAN are reactivated automatically.
   */
  protected onVlanRecreated(vlanId: number): string[] {
    const reactivated: string[] = [];
    for (const [portName, cfg] of this._getSwitchportConfigs()) {
      if (cfg.mode === 'access' && cfg.accessVlan === vlanId && this.portVlanStates.get(portName) === 'suspended') {
        this.portVlanStates.set(portName, 'active');
        reactivated.push(portName);
      }
    }
    return reactivated;
  }

  getOSType(): string { return 'cisco-ios'; }

  getBootSequence(): string {
    return [
      '',
      `Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.2(7)E2`,
      `Copyright (c) 1986-2025 by Cisco Systems, Inc.`,
      '',
      `${this.hostname} processor with 65536K bytes of memory.`,
      `${this.getPortNames().filter(n => n.startsWith('Fast')).length} FastEthernet interfaces`,
      `${this.getPortNames().filter(n => n.startsWith('Gig')).length} Gigabit Ethernet interfaces`,
      '',
      `Base ethernet MAC address: ${this.getPort(this.getPortNames()[0])?.getMAC() || '00:00:00:00:00:00'}`,
      '',
      'Press RETURN to get started.',
    ].join('\n');
  }
}

/** Map CDP neighbour rows to the inspection DTO `showCdp` consumes. */
function cdpToNeighborDTO(rows: readonly CdpNeighbor[]): NeighborDTO[] {
  return rows.map(n => ({
    localPort: n.localPort,
    remoteHost: n.remoteHost,
    remotePort: n.remotePort,
    remoteType: n.remoteType,
    remotePlatform: n.remotePlatform,
    remoteCapability: n.remoteCapability,
  }));
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
