/**
 * Tests for the base Equipment read-model (DeviceDetailVM / PortVM):
 *  - pure projections (projectDeviceDetail, projectPorts)
 *  - the reactive `deviceObservables` surface on a concrete Equipment.
 */

import { describe, it, expect } from 'vitest';
import { Equipment } from '@/network/equipment/Equipment';
import {
  projectDeviceDetail,
  projectPorts,
  type PortLike,
} from '@/network/equipment/observables';
import type { EthernetFrame } from '@/network/core/types';

// Minimal concrete device to exercise the abstract base.
class TestDevice extends Equipment {
  protected handleFrame(_portName: string, _frame: EthernetFrame): void {
    /* no-op for tests */
  }
}

function mockPort(over: Partial<Record<string, unknown>> = {}): PortLike {
  return {
    getName: () => (over.name as string) ?? 'GigabitEthernet0/0',
    getType: () => (over.type as string) ?? 'ethernet',
    getIsUp: () => (over.isUp as boolean) ?? true,
    getMAC: () => (over.mac as string) ?? 'aa:bb:cc:dd:ee:ff',
    getIPAddress: () => (over.ip as string | null) ?? null,
    getSubnetMask: () => (over.mask as string | null) ?? null,
    isConnected: () => (over.connected as boolean) ?? false,
  };
}

describe('projectDeviceDetail', () => {
  it('copies fields and clamps a negative uptime to 0', () => {
    expect(
      projectDeviceDetail({
        id: 'd1',
        name: 'R1',
        hostname: 'r1',
        type: 'router-cisco',
        poweredOn: true,
        uptimeMs: -5,
        portCount: 2,
      }),
    ).toEqual({
      id: 'd1',
      name: 'R1',
      hostname: 'r1',
      type: 'router-cisco',
      poweredOn: true,
      uptimeMs: 0,
      portCount: 2,
    });
  });
});

describe('projectPorts', () => {
  it('returns an empty array when there are no ports', () => {
    expect(projectPorts([])).toEqual([]);
  });

  it('projects an addressed, connected port', () => {
    const [vm] = projectPorts([mockPort({ ip: '10.0.0.1', mask: '255.255.255.0', connected: true })]);
    expect(vm.ipAddress).toBe('10.0.0.1');
    expect(vm.mask).toBe('255.255.255.0');
    expect(vm.connected).toBe(true);
    expect(vm.isUp).toBe(true);
  });

  it('keeps a null IP as null (no address configured)', () => {
    const [vm] = projectPorts([mockPort()]);
    expect(vm.ipAddress).toBeNull();
    expect(vm.mask).toBeNull();
  });
});

describe('Equipment.deviceObservables', () => {
  it('exposes the initial device detail', () => {
    const d = new TestDevice('router-cisco', 'R1');
    const detail = d.deviceObservables.detail.get();
    expect(detail.name).toBe('R1');
    expect(detail.type).toBe('router-cisco');
    expect(detail.poweredOn).toBe(true);
  });

  it('refreshes the detail signal when the device is renamed', () => {
    const d = new TestDevice('linux-pc', 'PC1');
    d.setName('PC2');
    expect(d.deviceObservables.detail.get().name).toBe('PC2');
  });

  it('reflects the power state in the detail signal', () => {
    const d = new TestDevice('linux-pc', 'PC1');
    d.powerOff();
    expect(d.deviceObservables.detail.get().poweredOn).toBe(false);
  });
});
