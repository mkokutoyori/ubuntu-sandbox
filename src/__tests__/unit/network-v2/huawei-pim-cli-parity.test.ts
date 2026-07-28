import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import {
  MACAddress, IPAddress, SubnetMask, resetCounters,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

let vts: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  vts = new VirtualTimeScheduler();
  __setDefaultScheduler(vts);
});

afterEach(() => {
  __setDefaultScheduler(null);
});

/** AR1 ── SW ── AR2, both VRP, so neighbours are real. */
function lab() {
  const bus = new EventBus();
  const r1 = new HuaweiRouter('AR1');
  const r2 = new HuaweiRouter('AR2');
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
  r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
  const p1 = r1.getPortNames()[0];
  const p2 = r2.getPortNames()[0];
  const swPorts = sw.getPortNames();
  new Cable('c1').connect(r1.getPort(p1)!, sw.getPort(swPorts[0])!);
  new Cable('c2').connect(r2.getPort(p2)!, sw.getPort(swPorts[1])!);
  r1.getPort(p1)!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  r2.getPort(p2)!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { bus, r1, r2, sw, p1, p2 };
}

async function run(r: HuaweiRouter, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of lines) out.push(await r.executeCommand(l));
  return out;
}

describe('Huawei VRP PIM CLI — interface view (P3)', () => {
  it('pim sm enables PIM sparse mode on the interface', async () => {
    const { r1, p1 } = lab();
    await run(r1, ['system-view', 'multicast routing-enable', `interface ${p1}`, 'pim sm']);
    const rt = r1.getPimAgent().getInterfaceRuntime(p1);
    expect(rt?.enabled).toBe(true);
    expect(rt?.mode).toBe('sparse');
  });

  it('pim dm is accepted but discloses that it behaves as sparse', async () => {
    const { r1, p1 } = lab();
    await run(r1, ['system-view', `interface ${p1}`]);
    const out = await r1.executeCommand('pim dm');
    expect(out).toMatch(/PIM-DM is accepted but behaves as PIM-SM/);
    expect(r1.getPimAgent().getInterfaceRuntime(p1)?.mode).toBe('dense');
  });

  it('undo pim sm disables it', async () => {
    const { r1, p1 } = lab();
    await run(r1, ['system-view', `interface ${p1}`, 'pim sm', 'undo pim sm']);
    expect(r1.getPimAgent().getInterfaceRuntime(p1)?.enabled).toBe(false);
  });

  it('pim hello-option dr-priority and pim timer hello drive the runtime', async () => {
    const { r1, p1 } = lab();
    await run(r1, [
      'system-view', `interface ${p1}`, 'pim sm',
      'pim hello-option dr-priority 100', 'pim timer hello 10',
    ]);
    const rt = r1.getPimAgent().getInterfaceRuntime(p1)!;
    expect(rt.drPriority).toBe(100);
    expect(rt.helloIntervalSec).toBe(10);
  });

  it('a bad dr-priority is rejected in VRP wording', async () => {
    const { r1, p1 } = lab();
    await run(r1, ['system-view', `interface ${p1}`, 'pim sm']);
    expect(await r1.executeCommand('pim hello-option dr-priority abc'))
      .toMatch(/Wrong parameter found/);
  });
});

describe('Huawei VRP PIM CLI — PIM view (P3)', () => {
  it('pim enters the PIM view and static-rp registers an RP', async () => {
    const { r1 } = lab();
    await run(r1, ['system-view', 'pim', 'static-rp 10.0.0.99']);
    expect(r1.getPimAgent().resolveRpForGroup('239.1.1.1')).toBe('10.0.0.99');
  });

  it('undo static-rp removes it', async () => {
    const { r1 } = lab();
    await run(r1, ['system-view', 'pim', 'static-rp 10.0.0.99', 'undo static-rp 10.0.0.99']);
    expect(r1.getPimAgent().resolveRpForGroup('239.1.1.1')).toBeNull();
  });

  it('static-rp rejects a malformed address', async () => {
    const { r1 } = lab();
    await run(r1, ['system-view', 'pim']);
    expect(await r1.executeCommand('static-rp nope')).toMatch(/Wrong parameter found/);
  });

  it('timer join-prune drives the engine interval', async () => {
    const { r1 } = lab();
    await run(r1, ['system-view', 'pim', 'timer join-prune 30']);
    expect(r1.getPimAgent().getConfig().joinPruneIntervalSec).toBe(30);
  });

  it('quit returns from the PIM view to the system view', async () => {
    const { r1 } = lab();
    await run(r1, ['system-view', 'pim']);
    expect(r1.getPrompt()).toMatch(/-pim\]$/);
    await r1.executeCommand('quit');
    expect(r1.getPrompt()).not.toMatch(/-pim\]$/);
  });

  it('multicast routing-enable is accepted', async () => {
    const { r1 } = lab();
    await run(r1, ['system-view']);
    expect(await r1.executeCommand('multicast routing-enable')).toBe('');
  });
});

describe('Huawei VRP PIM CLI — display commands (P3)', () => {
  it('display pim interface reports state, neighbour count and DR', async () => {
    const { r1, r2, p1, p2 } = lab();
    await run(r1, ['system-view', `interface ${p1}`, 'pim sm', 'quit', 'quit']);
    await run(r2, ['system-view', `interface ${p2}`, 'pim sm', 'quit', 'quit']);
    const out = await r1.executeCommand('display pim interface');
    expect(out).toMatch(new RegExp(p1.replace(/\//g, '\\/')));
    expect(out).toMatch(/up/);
    expect(out).toMatch(/DR-Address/);
  });

  it('display pim neighbor lists a real neighbour learned from Hello', async () => {
    const { r1, r2, p1, p2 } = lab();
    await run(r1, ['system-view', `interface ${p1}`, 'pim sm', 'quit', 'quit']);
    await run(r2, ['system-view', `interface ${p2}`, 'pim sm', 'quit', 'quit']);
    const out = await r1.executeCommand('display pim neighbor');
    expect(out).toMatch(/Total Number of Neighbors = 1/);
    expect(out).toMatch(/10\.0\.0\.2/);
  });

  it('display pim neighbor says so when there is none', async () => {
    const { r1 } = lab();
    expect(await r1.executeCommand('display pim neighbor')).toMatch(/No PIM neighbor exists/);
  });

  it('display pim rp-info shows the static RP', async () => {
    const { r1 } = lab();
    await run(r1, ['system-view', 'pim', 'static-rp 10.0.0.99', 'quit', 'quit']);
    const out = await r1.executeCommand('display pim rp-info');
    expect(out).toMatch(/PIM-SM static RP Number:1/);
    expect(out).toMatch(/Static RP Address is: 10\.0\.0\.99/);
  });

  it('display multicast routing-table renders the (*,G) entry', async () => {
    const { r1, r2, p1, p2 } = lab();
    await run(r1, ['system-view', 'pim', 'static-rp 10.0.0.2', 'quit',
      `interface ${p1}`, 'pim sm', 'quit', 'quit']);
    await run(r2, ['system-view', `interface ${p2}`, 'pim sm', 'quit', 'quit']);
    r1.getPimAgent().joinGroup('239.1.1.1', p1);
    const out = await r1.executeCommand('display multicast routing-table');
    expect(out).toMatch(/Total 1 entry/);
    expect(out).toMatch(/\(\*, 239\.1\.1\.1\)/);
    expect(out).toMatch(/downstream interface/);
  });

  it('display multicast routing-table says so when empty', async () => {
    const { r1 } = lab();
    expect(await r1.executeCommand('display multicast routing-table'))
      .toMatch(/No multicast routing entry is found/);
  });
});
