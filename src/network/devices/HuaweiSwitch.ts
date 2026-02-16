/**
 * HuaweiSwitch - Huawei S-series Layer 2 Switch (VRP)
 *
 * Huawei-specific behaviors:
 *   - Port naming: GigabitEthernet0/0/X (3-slot format)
 *   - STP: Standard 802.1D → ports start in listening state
 *     Must traverse listening → learning → forwarding before traffic flows.
 *   - VLAN deletion: access ports are moved back to default VLAN (VLAN 1).
 *     Unlike Cisco, ports do NOT become suspended — they continue
 *     forwarding traffic in VLAN 1.
 *   - VLAN recreation: no-op (ports were already moved to VLAN 1)
 *   - CLI: HuaweiVRPSwitchShell (VRP-style user/system/interface modes)
 *   - Boot: Huawei VRP S5720 format
 */

import { DeviceType } from '../core/types';
import { Switch, CiscoSwitchShell, HuaweiVRPSwitchShell, STPPortState } from './Switch';

export class HuaweiSwitch extends Switch {

  constructor(type: DeviceType = 'switch-huawei', name: string = 'Switch', portCount: number = 50, x: number = 0, y: number = 0) {
    super(type, name, portCount, x, y);
  }

  // ─── Vendor Hooks ──────────────────────────────────────────────

  protected getPortName(index: number, _total: number): string {
    return `GigabitEthernet0/0/${index}`;
  }

  protected getInitialSTPState(): STPPortState {
    // Huawei 802.1D: ports start in listening state
    return 'listening';
  }

  protected createShell(): CiscoSwitchShell | HuaweiVRPSwitchShell {
    return new HuaweiVRPSwitchShell();
  }

  /**
   * Huawei VRP VLAN deletion behavior:
   * Access ports assigned to a deleted VLAN are moved back to the
   * default VLAN (VLAN 1). They continue forwarding traffic normally.
   * This differs from Cisco where ports become suspended.
   */
  protected onVlanDeleted(vlanId: number, affectedPorts: string[]): void {
    const defaultVlan = this.vlans.get(1);
    for (const portName of affectedPorts) {
      const cfg = this._getSwitchportConfigs().get(portName);
      if (cfg) {
        cfg.accessVlan = 1; // Move port back to default VLAN
      }
      if (defaultVlan) {
        defaultVlan.ports.add(portName);
      }
      // Port stays active — NOT suspended
      this.portVlanStates.set(portName, 'active');
    }
  }

  /**
   * Huawei VLAN recreation behavior:
   * No ports to reactivate since they were never suspended.
   * Ports were moved to VLAN 1 on deletion and must be explicitly
   * re-assigned to the new VLAN via CLI commands.
   */
  protected onVlanRecreated(_vlanId: number): string[] {
    return []; // No automatic reactivation
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
