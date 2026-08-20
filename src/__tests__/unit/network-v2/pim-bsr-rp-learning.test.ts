import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

/** R1 (BSR) ── SW ── R2 (C-RP) ── … ── R3 (plain receiver-side router). */
function lab(count = 3) {
  const bus = new EventBus();
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  sw.setEventBus(bus);
  const routers: CiscoRouter[] = [];
  for (let i = 0; i < count; i++) {
    const r = new CiscoRouter(`R${i + 1}`);
    r.setEventBus(bus);
    new Cable(`c${i}`).connect(r.getPort('GigabitEthernet0/0')!, sw.getPort(`FastEthernet0/${i + 1}`)!);
    r.getPort('GigabitEthernet0/0')!
      .configureIP(new IPAddress(`10.0.0.${i + 1}`), new SubnetMask('255.255.255.0'));
    routers.push(r);
  }
  return { bus, sw, routers };
}

async function run(r: CiscoRouter, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of lines) out.push(await r.executeCommand(l));
  return out;
}

async function enablePim(r: CiscoRouter): Promise<void> {
  await run(r, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip pim sparse-mode', 'end',
  ]);
}

/** R1 is BSR, R2 advertises itself as candidate RP. */
async function bsrDomain() {
  const l = lab(3);
  const [r1, r2, r3] = l.routers;
  for (const r of l.routers) await enablePim(r);
  await run(r1, ['configure terminal', 'ip pim bsr-candidate GigabitEthernet0/0 30 100', 'end']);
  await run(r2, ['configure terminal', 'ip pim rp-candidate GigabitEthernet0/0 priority 10', 'end']);
  vts.advance(1_000);
  return { ...l, r1, r2, r3 };
}

describe('PIM BSR — dynamic RP learning (P1)', () => {
  it('a Candidate-RP reaches the BSR and comes back to every router', async () => {
    const { r1, r2, r3 } = await bsrDomain();
    expect(r1.getPimAgent().resolveRpForGroup('239.1.1.1')).toBe('10.0.0.2');
    expect(r2.getPimAgent().resolveRpForGroup('239.1.1.1')).toBe('10.0.0.2');
    expect(r3.getPimAgent().resolveRpForGroup('239.1.1.1')).toBe('10.0.0.2');
  });

  it('the learned entry is not static and carries its advertised priority', async () => {
    const { r3 } = await bsrDomain();
    const entry = r3.getPimAgent().resolveRpEntryForGroup('239.1.1.1')!;
    expect(entry.isStatic).toBe(false);
    expect(entry.priority).toBe(10);
    expect(entry.rpAddress).toBe('10.0.0.2');
  });

  it('publishes pim.rp.learned on a receiving router', async () => {
    const l = lab(2);
    const [r1, r2] = l.routers;
    for (const r of l.routers) await enablePim(r);
    const learned: Array<{ bsrIp: string; rps: Array<{ rpAddress: string }> }> = [];
    l.bus.subscribeWhere('pim.rp.learned', (p) => p.deviceId === r2.id, (e) => learned.push(e.payload));
    await run(r1, [
      'configure terminal',
      'ip pim bsr-candidate GigabitEthernet0/0 30 100',
      'ip pim rp-candidate GigabitEthernet0/0 priority 5', 'end',
    ]);
    vts.advance(1_000);
    expect(learned.some(e => e.bsrIp === '10.0.0.1'
      && e.rps.some(rp => rp.rpAddress === '10.0.0.1'))).toBe(true);
  });

  it('show ip pim rp mapping reports the bootstrap source', async () => {
    const { r3 } = await bsrDomain();
    const out = await r3.executeCommand('show ip pim rp mapping');
    expect(out).toMatch(/RP: 10\.0\.0\.2/);
    expect(out).toMatch(/via bootstrap, priority 10/);
    expect(out).toMatch(/Expires:/);
  });

  it('show ip pim rp mapping still says static for a configured RP', async () => {
    const l = lab(1);
    const [r1] = l.routers;
    await enablePim(r1);
    await run(r1, ['configure terminal', 'ip pim rp-address 10.0.0.50', 'end']);
    const out = await r1.executeCommand('show ip pim rp mapping');
    expect(out).toMatch(/Info source: static/);
    expect(out).not.toMatch(/bootstrap/);
  });

  it('the (*,G) mroute follows the RP learned by BSR', async () => {
    const { r3 } = await bsrDomain();
    r3.getPimAgent().joinGroup('239.5.5.5', 'GigabitEthernet0/0');
    expect(r3.getPimAgent().getMroute('239.5.5.5')?.rpAddress).toBe('10.0.0.2');
  });

  it('learned entries age out with their holdtime once the BSR goes silent', async () => {
    const { r1, r3 } = await bsrDomain();
    expect(r3.getPimAgent().resolveRpForGroup('239.1.1.1')).toBe('10.0.0.2');
    r1.getPimAgent().stop();
    vts.advance(200_000);
    expect(r3.getPimAgent().resolveRpForGroup('239.1.1.1')).toBeNull();
  });
});

describe('PIM BSR — static RP precedence (P1)', () => {
  it('a more specific static range beats a broader BSR-learned one', async () => {
    const { r3 } = await bsrDomain();
    await run(r3, ['configure terminal', 'end']);
    r3.getPimAgent().addStaticRp('10.0.0.77', '239.1.0.0', 16);
    expect(r3.getPimAgent().resolveRpForGroup('239.1.1.1')).toBe('10.0.0.77');
    // Outside that narrower range the BSR entry still applies.
    expect(r3.getPimAgent().resolveRpForGroup('239.9.9.9')).toBe('10.0.0.2');
  });

  it('on an equal mask the static entry wins', async () => {
    const { r3 } = await bsrDomain();
    r3.getPimAgent().addStaticRp('10.0.0.77', '224.0.0.0', 4);
    const entry = r3.getPimAgent().resolveRpEntryForGroup('239.1.1.1')!;
    expect(entry.isStatic).toBe(true);
    expect(entry.rpAddress).toBe('10.0.0.77');
  });

  it('a more specific BSR range still beats a broader static one', async () => {
    const l = lab(2);
    const [r1, r2] = l.routers;
    for (const r of l.routers) await enablePim(r);
    await run(r1, [
      'configure terminal',
      'ip pim bsr-candidate GigabitEthernet0/0 30 100', 'end',
    ]);
    r1.getPimAgent().setRpCandidate('10.0.0.1', 0, '239.1.0.0', 16);
    vts.advance(1_000);
    r2.getPimAgent().addStaticRp('10.0.0.77', '224.0.0.0', 4);
    expect(r2.getPimAgent().resolveRpForGroup('239.1.1.1')).toBe('10.0.0.1');
    expect(r2.getPimAgent().resolveRpForGroup('239.9.9.9')).toBe('10.0.0.77');
  });
});

describe('PIM BSR — Huawei parity (P1)', () => {
  it('c-bsr and c-rp in the VRP PIM view drive the same engine', async () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    sw.setEventBus(bus);
    const a1 = new HuaweiRouter('AR1');
    const a2 = new HuaweiRouter('AR2');
    a1.setEventBus(bus); a2.setEventBus(bus);
    const p1 = a1.getPortNames()[0];
    const p2 = a2.getPortNames()[0];
    new Cable('c1').connect(a1.getPort(p1)!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(a2.getPort(p2)!, sw.getPort('FastEthernet0/2')!);
    a1.getPort(p1)!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    a2.getPort(p2)!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    for (const [r, p] of [[a1, p1], [a2, p2]] as const) {
      for (const l of ['system-view', 'multicast routing-enable', `interface ${p}`, 'pim sm', 'quit', 'quit']) {
        await r.executeCommand(l);
      }
    }
    for (const l of ['system-view', 'pim', `c-bsr ${p1} 30 100`, `c-rp ${p1} priority 20`]) {
      await a1.executeCommand(l);
    }
    vts.advance(1_000);

    expect(a2.getPimAgent().getConfig().currentBsr?.address).toBe('10.0.0.1');
    expect(a2.getPimAgent().resolveRpForGroup('239.1.1.1')).toBe('10.0.0.1');

    await a2.executeCommand('quit');
    const out = await a2.executeCommand('display pim rp-info');
    expect(out).toMatch(/PIM-SM BSR RP Number:1/);
    expect(out).toMatch(/RP: 10\.0\.0\.1/);
    expect(out).toMatch(/Priority: 20/);

    const bsrOut = await a2.executeCommand('display pim bsr-info');
    expect(bsrOut).toMatch(/Elected BSR Address: 10\.0\.0\.1/);
  });
});
