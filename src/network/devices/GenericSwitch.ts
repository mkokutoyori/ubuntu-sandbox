/**
 * GenericSwitch - Basic unmanaged Layer 2 Switch
 *
 * Uses simple eth0..ethN port naming and Cisco-like defaults.
 * For use when no specific vendor behavior is needed.
 */

import { DeviceType } from '../core/types';
import { Switch, STPPortState } from './Switch';
import type { ISwitchShell } from './shells/ISwitchShell';
import { CiscoSwitchShell } from './shells/CiscoSwitchShell';

export class GenericSwitch extends Switch {

  constructor(type: DeviceType = 'switch-generic', name: string = 'Switch', portCount: number = 50, x: number = 0, y: number = 0) {
    super(type, name, portCount, x, y);
  }

  protected getPortName(index: number, _total: number): string {
    return `eth${index}`;
  }

  protected getInitialSTPState(): STPPortState {
    return 'forwarding';
  }

  protected createShell(): ISwitchShell {
    return new CiscoSwitchShell();
  }

  protected onVlanDeleted(_vlanId: number, affectedPorts: string[]): void {
    // Generic: move ports to VLAN 1 (basic switch behavior)
    const defaultVlan = this.vlans.get(1);
    for (const portName of affectedPorts) {
      const cfg = this._getSwitchportConfigs().get(portName);
      if (cfg) cfg.accessVlan = 1;
      if (defaultVlan) defaultVlan.ports.add(portName);
    }
  }

  protected onVlanRecreated(_vlanId: number): string[] {
    return [];
  }

  /**
   * The CLI this switch actually runs.
   *
   * `getOSType()` is read everywhere as "which shell dialect is this" —
   * `Router` delegates it straight to `this.shell.getOSType()`, and both
   * `sessionFactory` and `primaryShellKindFor` dispatch on it. Answering
   * `'generic'` therefore fell through to the POSIX default, so a switch
   * whose only shell is `CiscoSwitchShell` was given a **bash** terminal
   * in the UI: `exit` from `config-vlan` logged the operator out instead
   * of going up one level, and the prompt, modes, Ctrl+Z and pager were
   * all the wrong platform's. Nothing else read `'generic'`.
   */
  getOSType(): string { return 'cisco-ios'; }

  getBootSequence(): string {
    return [
      '',
      `${this.hostname} switch starting...`,
      `${this.getPortNames().length} Ethernet interfaces`,
      '',
    ].join('\n');
  }
}
