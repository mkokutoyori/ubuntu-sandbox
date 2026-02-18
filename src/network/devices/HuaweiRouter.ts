/**
 * HuaweiRouter - Huawei VRP Router specialization
 *
 * Extends abstract Router with Huawei-specific:
 *   - Port naming: GE0/0/X
 *   - CLI shell: HuaweiVRPShell
 *   - Boot sequence: Huawei VRP bootstrap
 */

import { Router } from './Router';
import type { IRouterShell } from './shells/IRouterShell';
import { HuaweiVRPShell } from './shells/HuaweiVRPShell';

export class HuaweiRouter extends Router {
  constructor(name: string = 'Router', x: number = 0, y: number = 0) {
    super('router-huawei', name, x, y);
  }

  protected getVendorPortName(index: number): string {
    return `GE0/0/${index}`;
  }

  protected createShell(): IRouterShell {
    return new HuaweiVRPShell();
  }

  getBootSequence(): string {
    const ports = this._getPortsInternal();
    return [
      '',
      'Huawei Versatile Routing Platform Software',
      'VRP (R) software, Version 5.170 (AR2220 V200R009C00SPC500)',
      'Copyright (C) 2000-2025 HUAWEI TECH CO., LTD',
      '',
      'BOARD TYPE:          AR2220',
      'BootROM Version:     1.0',
      '',
      `${ports.size} GigabitEthernet interfaces`,
      '',
      `Base ethernet MAC address: ${ports.values().next().value?.getMAC() || '00:00:00:00:00:00'}`,
      '',
      'Press any key to get started.',
    ].join('\n');
  }
}
