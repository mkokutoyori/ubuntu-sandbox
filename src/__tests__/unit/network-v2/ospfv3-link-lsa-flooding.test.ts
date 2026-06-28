import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function configureOspfv3(r: CiscoRouter, routerId: string, ipv6: string): Promise<void> {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('ipv6 unicast-routing');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand(`ipv6 address ${ipv6}/64`);
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  await r.executeCommand('ipv6 router ospf 1');
  await r.executeCommand(`router-id ${routerId}`);
  await r.executeCommand('exit');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand('ipv6 ospf 1 area 0');
  await r.executeCommand('end');
}

describe('OSPFv3 Link-LSA flooding (RFC 5340 §4.4.1) — GAP §3.4', () => {
  it('each neighbor receives the peer Link-LSA on the shared link after auto-convergence', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await configureOspfv3(r1, '1.1.1.1', '2001:db8:12::1');
    await configureOspfv3(r2, '1.1.1.2', '2001:db8:12::2');
    new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    await r1.executeCommand('show ipv6 ospf neighbor');

    const v3R1 = r1._getOSPFv3EngineInternal();
    const v3R2 = r2._getOSPFv3EngineInternal();
    expect(v3R1).toBeTruthy();
    expect(v3R2).toBeTruthy();

    const remoteOnR1 = v3R1!.getRemoteLinkLSAs('GigabitEthernet0/0');
    const remoteOnR2 = v3R2!.getRemoteLinkLSAs('GigabitEthernet0/0');
    expect(remoteOnR1.map((l) => l.advertisingRouter)).toContain('1.1.1.2');
    expect(remoteOnR2.map((l) => l.advertisingRouter)).toContain('1.1.1.1');
  });

  it('installRemoteLinkLSA refuses an older sequence number (RFC 5340 §4.6 freshness)', async () => {
    const r1 = new CiscoRouter('R1');
    await configureOspfv3(r1, '1.1.1.1', '2001:db8::1');
    const eng = r1._getOSPFv3EngineInternal();
    expect(eng).toBeTruthy();

    const newer = eng!.originateLinkLSA('Loopback0', 'fe80::a', []);
    const older = { ...newer, advertisingRouter: '9.9.9.9', lsSequenceNumber: 0x80000001 };
    const olderStill = { ...older, lsSequenceNumber: 0x80000000 };
    expect(eng!.installRemoteLinkLSA('GigabitEthernet0/0', older as never)).toBe(true);
    expect(eng!.installRemoteLinkLSA('GigabitEthernet0/0', olderStill as never)).toBe(false);
    expect(eng!.installRemoteLinkLSA('GigabitEthernet0/0', { ...older, lsSequenceNumber: 0x80000005 } as never)).toBe(true);
  });
});
