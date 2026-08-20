import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import {
  MACAddress, IPAddress, SubnetMask, resetCounters,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function lab() {
  const bus = new EventBus();
  const r = new CiscoRouter('R1');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  r.setEventBus(bus); sw.setEventBus(bus);
  new Cable('c1').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  return { bus, r, sw };
}

async function run(r: CiscoRouter, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of lines) out.push(await r.executeCommand(l));
  return out;
}

describe('PIM — dense mode disclosure (P2)', () => {
  it('ip pim dense-mode says the behaviour stays sparse', async () => {
    const { r } = lab();
    await run(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0']);
    const out = await r.executeCommand('ip pim dense-mode');
    expect(out).toMatch(/dense mode is accepted but behaves as sparse mode/);
    expect(out).toMatch(/flood-and-prune is not modelled/);
  });

  it('ip pim sparse-dense-mode carries the same warning', async () => {
    const { r } = lab();
    await run(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0']);
    expect(await r.executeCommand('ip pim sparse-dense-mode'))
      .toMatch(/behaves as sparse mode/);
  });

  it('ip pim sparse-mode stays silent, like real IOS', async () => {
    const { r } = lab();
    await run(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0']);
    expect(await r.executeCommand('ip pim sparse-mode')).toBe('');
  });

  it('show ip pim interface footers the note when a dense interface exists', async () => {
    const { r } = lab();
    await run(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip pim dense-mode', 'end',
    ]);
    const out = await r.executeCommand('show ip pim interface');
    expect(out).toMatch(/GigabitEthernet0\/0/);
    expect(out).toMatch(/v2\/dense/);
    expect(out).toMatch(/behaves as sparse mode/);
  });

  it('show ip pim interface has no note when every interface is sparse', async () => {
    const { r } = lab();
    await run(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip pim sparse-mode', 'end',
    ]);
    const out = await r.executeCommand('show ip pim interface');
    expect(out).toMatch(/v2\/sparse/);
    expect(out).not.toMatch(/behaves as sparse mode/);
  });

  it('the mode is still stored and displayed as configured', async () => {
    const { r } = lab();
    await run(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip pim dense-mode', 'end',
    ]);
    expect(r.getPimAgent().getInterfaceRuntime('GigabitEthernet0/0')?.mode).toBe('dense');
  });

  it('non-regression: a dense interface still builds explicit (*,G) join state', async () => {
    const { r } = lab();
    await run(r, [
      'enable', 'configure terminal',
      'ip pim rp-address 10.0.0.99',
      'interface GigabitEthernet0/0', 'ip pim dense-mode', 'end',
    ]);
    r.getPimAgent().joinGroup('239.1.1.1', 'GigabitEthernet0/0');
    const m = r.getPimAgent().getMroute('239.1.1.1');
    expect(m).toBeDefined();
    expect(m!.entryType).toBe('star-g');
    expect(m!.outgoingInterfaces.has('GigabitEthernet0/0')).toBe(true);
    expect(m!.rpAddress).toBe('10.0.0.99');
  });
});
