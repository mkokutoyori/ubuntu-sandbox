import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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

async function run(d: { executeCommand(c: string): Promise<string> }, cmds: string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

describe('show spanning-tree summary — live agent projection', () => {
  it('reports "Root bridge for: VLAN0001" once the switch becomes root', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4, 0, 0);
    await run(sw, [
      'enable', 'configure terminal',
      'spanning-tree vlan 1 priority 4096',
      'end',
    ]);
    const out = await sw.executeCommand('show spanning-tree summary');
    expect(out).toContain('Root bridge for: VLAN0001');
    expect(out).not.toMatch(/Root bridge for: none/);
  });

  it('reports "Root bridge for: none" when another bridge has lower priority', async () => {
    const root = new CiscoSwitch('switch-cisco', 'ROOT', 4, 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4, 0, 0);
    new Cable('c1').connect(root.getPort('FastEthernet0/1')!, sw.getPort('FastEthernet0/1')!);
    await run(root, ['enable', 'configure terminal', 'spanning-tree vlan 1 priority 0', 'end']);
    await run(sw, ['enable', 'configure terminal', 'spanning-tree vlan 1 priority 32768', 'end']);
    await new Promise((r) => setTimeout(r, 100));
    const out = await sw.executeCommand('show spanning-tree summary');
    expect(out).toMatch(/Root bridge for: none/);
  });

  it('reflects global PortFast / BPDU Guard toggles from the agent', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4, 0, 0);
    await run(sw, [
      'enable', 'configure terminal',
      'spanning-tree portfast default',
      'spanning-tree portfast bpduguard default',
      'end',
    ]);
    const out = await sw.executeCommand('show spanning-tree summary');
    expect(out).toMatch(/Portfast Default\s+is enabled/);
    expect(out).toMatch(/PortFast BPDU Guard Default\s+is enabled/);
  });

  it('reflects the configured pathcost method', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4, 0, 0);
    await run(sw, [
      'enable', 'configure terminal',
      'spanning-tree pathcost method long',
      'end',
    ]);
    const out = await sw.executeCommand('show spanning-tree summary');
    expect(out).toMatch(/Configured Pathcost method used is long/);
  });

  it('encodes the VLAN id into displayed Bridge / Root priority (PVST+ system-id-extension)', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4, 0, 0);
    await run(sw, ['enable', 'configure terminal', 'spanning-tree vlan 1 priority 4096', 'end']);
    const t1 = await sw.executeCommand('show spanning-tree');
    expect(t1).toMatch(/Priority\s+4097\b/);

    await run(sw, [
      'enable', 'configure terminal',
      'vlan 100', 'exit',
      'spanning-tree vlan 100 priority 4096',
      'end',
    ]);
    const bridge = await sw.executeCommand('show spanning-tree vlan 100 bridge');
    expect(bridge).toMatch(/VLAN0100\s+4196 \(4096, 100\)/);
  });
});

describe('display stp — live agent projection (Huawei)', () => {
  async function sysSwitch(): Promise<HuaweiSwitch> {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    await run(sw, ['system-view']);
    return sw;
  }

  it('reflects the configured bridge priority and timers (not the static template)', async () => {
    const sw = await sysSwitch();
    await run(sw, [
      'stp mode rstp',
      'stp root primary',
      'return',
    ]);
    const out = await sw.executeCommand('display stp');
    expect(out).toContain('CIST Bridge         :0.SW1');
    expect(out).toContain('Hello 2s MaxAge 20s FwDly 15s');
  });

  it('reports a non-zero root MAC once an agent has elected a root', async () => {
    const sw = await sysSwitch();
    await run(sw, ['stp root primary', 'return']);
    const out = await sw.executeCommand('display stp');
    expect(out).not.toMatch(/0000-0000-0000/);
    expect(out).toMatch(/CIST Root\/ERPC\s+:0\.[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4} \/ 0/);
  });

  it('reports the configured RSTP mode', async () => {
    const sw = await sysSwitch();
    await run(sw, ['stp mode rstp', 'return']);
    const out = await sw.executeCommand('display stp');
    expect(out).toMatch(/\[Mode RSTP\]/);
  });
});
