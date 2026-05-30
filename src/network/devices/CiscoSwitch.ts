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

import { DeviceType, EthernetFrame } from '../core/types';
import { Switch, STPPortState } from './Switch';
import type { ISwitchShell } from './shells/ISwitchShell';
import { CiscoSwitchShell } from './shells/CiscoSwitchShell';
import { CdpAgent, type CdpNeighbor } from '../cdp/CdpAgent';
import { ETHERTYPE_CDP } from '../cdp/types';
import type { NeighborDTO } from './inspection/DeviceStateView';
import type { IEventBus } from '@/events/EventBus';

export class CiscoSwitch extends Switch {
  private readonly cdpAgent: CdpAgent;

  constructor(type: DeviceType = 'switch-cisco', name: string = 'Switch', portCount: number = 50, x: number = 0, y: number = 0) {
    super(type, name, portCount, x, y);
    this.cdpAgent = new CdpAgent({
      id: this.id, name: this.name,
      getHostname: () => this.getHostname(),
      getType: () => this.getType(),
      getPort: (n) => this.getPort(n),
      getPorts: () => this.getPorts(),
      sendFrame: (p, f) => { this.sendFrame(p, f); },
      getNativeVlan: (p) => this.getSwitchportConfig(p)?.accessVlan,
    }, () => this.getBus());
    this.cdpAgent.start();
  }

  // ─── CDP integration ──────────────────────────────────────────

  override setEventBus(bus: IEventBus | null): void {
    super.setEventBus(bus);
    // Subscribers are bus-bound; rewire on bus change.
    if (this.cdpAgent) { this.cdpAgent.stop(); this.cdpAgent.start(); }
  }

  protected override handleFrame(portName: string, frame: EthernetFrame): void {
    if (frame.etherType === ETHERTYPE_CDP) {
      this.cdpAgent.handleFrame(portName, frame);
      return; // never flood / never MAC-learn link-local protocol frames
    }
    super.handleFrame(portName, frame);
  }

  getCdpAgent(): CdpAgent { return this.cdpAgent; }
  getCdpNeighbors(): NeighborDTO[] { return cdpToNeighborDTO(this.cdpAgent.getNeighbors()); }

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
