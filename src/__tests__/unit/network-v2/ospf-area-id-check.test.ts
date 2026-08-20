import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { normalizeAreaId, areasEqual, isBackboneAreaId } from '@/network/ospf/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Configurable { executeCommand(cmd: string): Promise<string> }
const cfg = async (d: Configurable, cmds: string[]) => {
  for (const c of cmds) await d.executeCommand(c);
};

function pair(areaLeft: string, areaRight: string) {
  const left = new CiscoRouter('R-LEFT', 0, 0);
  const right = new CiscoRouter('R-RIGHT', 200, 0);
  new Cable('link').connect(
    left.getPort('GigabitEthernet0/1')!,
    right.getPort('GigabitEthernet0/1')!,
  );
  const bring = async () => {
    await cfg(left, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.1.1.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'router-id 1.1.1.1',
      'network 10.1.1.0 0.0.0.255 area ' + areaLeft,
      'network 10.0.0.0 0.0.0.3 area ' + areaLeft,
      'end',
    ]);
    await cfg(right, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.2.2.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'router-id 2.2.2.2',
      'network 10.2.2.0 0.0.0.255 area ' + areaRight,
      'network 10.0.0.0 0.0.0.3 area ' + areaRight,
      'end',
    ]);
  };
  return { left, right, bring };
}

describe('normalizeAreaId', () => {
  it('renders a decimal area as its 32-bit dotted form', () => {
    expect(normalizeAreaId('0')).toBe('0.0.0.0');
    expect(normalizeAreaId('1')).toBe('0.0.0.1');
    expect(normalizeAreaId('256')).toBe('0.0.1.0');
    expect(normalizeAreaId('4294967295')).toBe('255.255.255.255');
  });

  it('leaves an already-dotted area alone', () => {
    expect(normalizeAreaId('0.0.0.0')).toBe('0.0.0.0');
    expect(normalizeAreaId('10.1.2.3')).toBe('10.1.2.3');
  });

  it('hands back anything it cannot read, so it still equals itself', () => {
    for (const odd of ['', '  ', 'area', '1.2.3', '1.2.3.4.5', '1.2.3.999', '4294967296']) {
      expect(normalizeAreaId(odd)).toBe(odd);
      expect(areasEqual(odd, odd)).toBe(true);
    }
  });

  it('recognises both spellings of the same area', () => {
    expect(areasEqual('0', '0.0.0.0')).toBe(true);
    expect(areasEqual('1', '0.0.0.1')).toBe(true);
    expect(areasEqual('0', '1')).toBe(false);
    expect(isBackboneAreaId('0')).toBe(true);
    expect(isBackboneAreaId('0.0.0.0')).toBe(true);
    expect(isBackboneAreaId('1')).toBe(false);
  });
});

describe('OSPF — Area ID check on received packets (RFC 2328 §8.2)', () => {
  it('refuses the adjacency when the two ends declare different areas', async () => {
    const { left, right, bring } = pair('0', '1');
    await bring();

    expect(await left.executeCommand('show ip ospf neighbor')).not.toContain('2.2.2.2');
    expect(await right.executeCommand('show ip ospf neighbor')).not.toContain('1.1.1.1');
    expect(await left.executeCommand('show ip route')).not.toContain('10.2.2.0');
    expect(await right.executeCommand('show ip route')).not.toContain('10.1.1.0');
  });

  it('reports the drop the way IOS does', async () => {
    const { left, bring } = pair('0', '1');
    await cfg(left, ['enable', 'configure terminal', 'logging buffered 16384 debugging', 'end']);
    await bring();

    const log = await left.executeCommand('show logging');
    expect(log).toContain('%OSPF-4-ERRRCV');
    expect(log).toContain('mismatch area ID');
    expect(log).toContain('10.0.0.2');
  });

  it('still forms the adjacency when the areas match', async () => {
    const { left, right, bring } = pair('0', '0');
    await bring();

    expect(await left.executeCommand('show ip ospf neighbor')).toContain('2.2.2.2');
    expect(await left.executeCommand('show ip route')).toContain('10.2.2.0');
    expect(await right.executeCommand('show ip route')).toContain('10.1.1.0');
  });

  it('treats area 0 and area 0.0.0.0 as the same area', async () => {
    const { left, right, bring } = pair('0', '0.0.0.0');
    await bring();

    expect(await left.executeCommand('show ip ospf neighbor')).toContain('2.2.2.2');
    expect(await left.executeCommand('show ip route')).toContain('10.2.2.0');
    expect(await right.executeCommand('show ip route')).toContain('10.1.1.0');
  });

  it('treats area 1 and area 0.0.0.1 as the same area', async () => {
    const { left, right, bring } = pair('1', '0.0.0.1');
    await bring();

    expect(await left.executeCommand('show ip ospf neighbor')).toContain('2.2.2.2');
    expect(await left.executeCommand('show ip route')).toContain('10.2.2.0');
  });

  it('drops a backbone packet reaching a non-backbone interface with no virtual link', async () => {
    const { left, right, bring } = pair('1', '0');
    await bring();

    expect(await left.executeCommand('show ip ospf neighbor')).not.toContain('2.2.2.2');
    expect(await right.executeCommand('show ip ospf neighbor')).not.toContain('1.1.1.1');
  });
});
