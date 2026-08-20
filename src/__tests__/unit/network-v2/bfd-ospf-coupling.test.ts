/**
 * BFD coupled to OSPF (rapport 02 audit, item #42). `ip ospf bfd`/
 * `bfd all-interfaces` were accepted syntax with zero behavioral wiring:
 * a BFD session going down never affected the OSPF neighbor, defeating
 * BFD's whole purpose (sub-second failure detection faster than OSPF's
 * own dead-interval). EIGRP/BGP coupling is a larger, separate lift
 * (documented in CLAUDE.md) and isn't covered here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function ospfPairWithBfd(): Promise<{ r1: CiscoRouter; r2: CiscoRouter }> {
  const r1 = new CiscoRouter('router-cisco', 'R1');
  const r2 = new CiscoRouter('router-cisco', 'R2');
  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

  for (const [r, ip] of [[r1, '10.0.2.1'], [r2, '10.0.2.2']] as const) {
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand(`ip address ${ip} 255.255.255.0`);
    await r.executeCommand('ip ospf bfd');
    await r.executeCommand('no shutdown');
    await r.executeCommand('exit');
    await r.executeCommand('router ospf 1');
    await r.executeCommand('network 10.0.2.0 0.0.0.255 area 0');
    await r.executeCommand('end');
  }
  return { r1, r2 };
}

describe('OSPF auto-provisions a BFD session for a Full neighbor on a BFD-enabled interface', () => {
  it('a BFD session exists between the two OSPF neighbors after convergence', async () => {
    const { r1, r2 } = await ospfPairWithBfd();
    expect(r1.getBfdAgent().getSession('GigabitEthernet0/0', '10.0.2.2')).toBeDefined();
    expect(r2.getBfdAgent().getSession('GigabitEthernet0/0', '10.0.2.1')).toBeDefined();
  });
});

describe('a BFD session going down kills the OSPF neighbor immediately', () => {
  it('setAdmin(false) on the BFD session tears down the neighbor with no CLI/dead-interval wait', async () => {
    const { r1, r2 } = await ospfPairWithBfd();
    r1.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.2.2');
    r2.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.2.1');
    expect((await r1.executeCommand('show ip ospf neighbor')).trim()).toContain('10.0.2.2');

    r1.getBfdAgent().setAdmin('GigabitEthernet0/0', '10.0.2.2', false);

    const neighbor = r1._getOSPFEngineInternal()!.getNeighbors().find((n) => n.ipAddress === '10.0.2.2');
    expect(neighbor?.state).not.toBe('Full');
  });

  it('a BFD-unrelated interface is unaffected by an unrelated BFD session going down', async () => {
    const { r1 } = await ospfPairWithBfd();
    r1.getBfdAgent().ensureSession('GigabitEthernet0/1', '192.0.2.9');
    r1.getBfdAgent().setAdmin('GigabitEthernet0/1', '192.0.2.9', false);
    const neighbor = r1._getOSPFEngineInternal()!.getNeighbors().find((n) => n.ipAddress === '10.0.2.2');
    expect(neighbor?.state).toBe('Full');
  });
});

describe('Huawei ospf bfd enable / bfd all-interfaces enable actually wire, not just accept syntax', () => {
  it('a BFD session down transitions the OSPF neighbor away from Full', async () => {
    const r1 = new HuaweiRouter('router-huawei', 'R1');
    const r2 = new HuaweiRouter('router-huawei', 'R2');
    new Cable('c1').connect(r1.getPort('GE0/0/0')!, r2.getPort('GE0/0/0')!);

    for (const [r, ip] of [[r1, '10.0.2.1'], [r2, '10.0.2.2']] as const) {
      await r.executeCommand('system-view');
      await r.executeCommand('interface GE0/0/0');
      await r.executeCommand(`ip address ${ip} 255.255.255.0`);
      await r.executeCommand('ospf bfd enable');
      await r.executeCommand('undo shutdown');
      await r.executeCommand('quit');
      await r.executeCommand('ospf 1');
      await r.executeCommand('area 0');
      await r.executeCommand('network 10.0.2.0 0.0.0.255');
      await r.executeCommand('return');
      // display ospf interface is what actually triggers convergence for
      // Huawei (display ospf peer doesn't) — unrelated pre-existing gap.
      await r.executeCommand('display ospf interface');
    }
    r1.getBfdAgent().ensureSession('GE0/0/0', '10.0.2.2');
    r2.getBfdAgent().ensureSession('GE0/0/0', '10.0.2.1');
    expect(r1.getBfdAgent().getSession('GE0/0/0', '10.0.2.2')).toBeDefined();
    expect(r1._getOSPFEngineInternal()!.getNeighbors().find((n) => n.ipAddress === '10.0.2.2')?.state).toBe('Full');

    r1.getBfdAgent().setAdmin('GE0/0/0', '10.0.2.2', false);

    const neighbor = r1._getOSPFEngineInternal()!.getNeighbors().find((n) => n.ipAddress === '10.0.2.2');
    expect(neighbor?.state).not.toBe('Full');
  });
});
