import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { ETHERTYPE_LLDP, LLDP_MULTICAST_MAC } from '@/network/lldp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function enableLldp(dev: CiscoRouter | CiscoSwitch): Promise<void> {
  await dev.executeCommand('enable');
  await dev.executeCommand('configure terminal');
  await dev.executeCommand('lldp run');
  await dev.executeCommand('end');
}

describe('LLDP — defaults & lifecycle', () => {
  it('LLDP is disabled by default on a Cisco router', () => {
    const r = new CiscoRouter('R1');
    expect(r.getLldpAgent().getConfig().enabled).toBe(false);
  });

  it('LLDP is disabled by default on a Cisco switch', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    expect(sw.getLldpAgent().getConfig().enabled).toBe(false);
  });

  it('lldp run starts advertising; show lldp returns Status: ACTIVE', async () => {
    const r = new CiscoRouter('R1');
    await enableLldp(r);
    expect(r.getLldpAgent().getConfig().enabled).toBe(true);
    const out = await r.executeCommand('show lldp');
    expect(out).toMatch(/Status: ACTIVE/);
    expect(out).toMatch(/advertisements are sent every 30 seconds/);
  });

  it('no lldp run flushes the local table and stops advertising', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('w').connect(r1.getPort('GigabitEthernet0/1')!,
                           r2.getPort('GigabitEthernet0/1')!);
    await enableLldp(r1);
    await enableLldp(r2);
    expect(r1.getLldpAgent().getNeighbors().length).toBe(1);

    await r1.executeCommand('configure terminal');
    await r1.executeCommand('no lldp run');
    await r1.executeCommand('end');
    expect(r1.getLldpAgent().getNeighbors().length).toBe(0);
    expect(r1.getLldpAgent().getConfig().enabled).toBe(false);
  });
});

describe('LLDP — discovery', () => {
  it('two routers with lldp run discover each other', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('w').connect(r1.getPort('GigabitEthernet0/1')!,
                           r2.getPort('GigabitEthernet0/1')!);
    await enableLldp(r1);
    await enableLldp(r2);
    const n1 = r1.getLldpAgent().getNeighbors();
    const n2 = r2.getLldpAgent().getNeighbors();
    expect(n1.length).toBe(1);
    expect(n1[0].systemName).toBe('R2');
    expect(n1[0].portId).toBe('GigabitEthernet0/1');
    expect(n1[0].remoteCapabilities).toContain('Router');
    expect(n2[0].systemName).toBe('R1');
  });

  it('switch <-> switch discovery uses the Bridge capability', async () => {
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    new Cable('w').connect(s1.getPort('FastEthernet0/0')!,
                           s2.getPort('FastEthernet0/0')!);
    await enableLldp(s1);
    await enableLldp(s2);
    const n = s1.getLldpAgent().getNeighbors()[0];
    expect(n).toBeDefined();
    expect(n.systemName).toBe('SW2');
    expect(n.remoteCapabilities).toContain('Bridge');
  });

  it('LinuxPC peer is invisible to LLDP (no agent)', async () => {
    const r1 = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'L1', 0, 0);
    new Cable('w').connect(r1.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await enableLldp(r1);
    expect(r1.getLldpAgent().getNeighbors().length).toBe(0);
  });
});

describe('LLDP — per-interface transmit / receive', () => {
  it('no lldp transmit suppresses outbound and flushes the port', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('w').connect(r1.getPort('GigabitEthernet0/1')!,
                           r2.getPort('GigabitEthernet0/1')!);
    await enableLldp(r1);
    await enableLldp(r2);
    expect(r2.getLldpAgent().getNeighbors().length).toBe(1);

    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/1');
    await r1.executeCommand('no lldp transmit');
    await r1.executeCommand('end');
    expect(r1.getLldpAgent().isPortTransmitEnabled('GigabitEthernet0/1')).toBe(false);
  });

  it('no lldp receive flushes existing neighbours on that port', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('w').connect(r1.getPort('GigabitEthernet0/1')!,
                           r2.getPort('GigabitEthernet0/1')!);
    await enableLldp(r1);
    await enableLldp(r2);
    expect(r1.getLldpAgent().getNeighbors().length).toBe(1);

    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/1');
    await r1.executeCommand('no lldp receive');
    await r1.executeCommand('end');
    expect(r1.getLldpAgent().getNeighbors().length).toBe(0);
    expect(r1.getLldpAgent().isPortReceiveEnabled('GigabitEthernet0/1')).toBe(false);
  });
});

describe('LLDP — global knobs', () => {
  it('lldp timer / lldp holdtime-multiplier mutate config and persist', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('lldp run');
    await sw.executeCommand('lldp timer 15');
    await sw.executeCommand('lldp holdtime-multiplier 3');
    await sw.executeCommand('lldp reinit 5');
    await sw.executeCommand('end');

    const cfg = sw.getLldpAgent().getConfig();
    expect(cfg.timerSec).toBe(15);
    expect(cfg.holdtimeMultiplier).toBe(3);
    expect(cfg.reinitDelaySec).toBe(5);

    const run = sw.getRunningConfig();
    expect(run).toMatch(/lldp timer 15/);
    expect(run).toMatch(/lldp holdtime-multiplier 3/);
    expect(run).toMatch(/lldp reinit 5/);

    const showed = await sw.executeCommand('show lldp');
    expect(showed).toMatch(/sent every 15 seconds/);
    expect(showed).toMatch(/hold time advertised is 45 seconds/);
  });

  it('show lldp interface reports per-port Tx / Rx state', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await enableLldp(sw);
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('no lldp transmit');
    await sw.executeCommand('end');
    const out = await sw.executeCommand('show lldp interface');
    expect(out).toMatch(/FastEthernet0\/0:[\s\S]*Tx: disabled/);
    expect(out).toMatch(/FastEthernet0\/1:[\s\S]*Tx: enabled/);
  });

  it('show lldp neighbors detail exposes chassis-id, port-id, system desc', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('w').connect(r1.getPort('GigabitEthernet0/1')!,
                           r2.getPort('GigabitEthernet0/1')!);
    await enableLldp(r1);
    await enableLldp(r2);
    const out = await r1.executeCommand('show lldp neighbors detail');
    expect(out).toMatch(/Local Intf: GigabitEthernet0\/1/);
    expect(out).toMatch(/System Name: R2/);
    expect(out).toMatch(/Chassis id: [0-9a-f:]+/);
    expect(out).toMatch(/Time remaining: \d+ seconds/);
  });
});

describe('LLDP — reactive events', () => {
  it('frame.sent + neighbor.discovered fire on enabling LLDP', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    r1.setEventBus(bus);
    r2.setEventBus(bus);
    new Cable('w').connect(r1.getPort('GigabitEthernet0/1')!,
                           r2.getPort('GigabitEthernet0/1')!);

    const sent: Array<{ port: string; reason: string }> = [];
    const found: Array<{ remoteSystem: string }> = [];
    bus.subscribe('lldp.frame.sent', (e) => sent.push(e.payload));
    bus.subscribe('lldp.neighbor.discovered', (e) => found.push(e.payload));

    await enableLldp(r1);
    await enableLldp(r2);

    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(found.some(f => f.remoteSystem === 'R2')).toBe(true);
    expect(found.some(f => f.remoteSystem === 'R1')).toBe(true);
  });

  it('port.link.down expires the neighbour with cause "link-down"', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('w').connect(r1.getPort('GigabitEthernet0/1')!,
                           r2.getPort('GigabitEthernet0/1')!);
    await enableLldp(r1);
    await enableLldp(r2);

    const bus = new EventBus();
    r1.setEventBus(bus);
    r2.setEventBus(bus);
    const events: Array<{ cause: string }> = [];
    bus.subscribe('lldp.neighbor.expired', (e) => events.push(e.payload));

    r1.getPort('GigabitEthernet0/1')!.setUp(false);
    expect(events.some(e => e.cause === 'link-down')).toBe(true);
  });
});

describe('LLDP — frame is link-local', () => {
  it('LLDP frames are consumed at a switch (no flood, no MAC learn)', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!,
                           sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!,
                           sw.getPort('FastEthernet0/1')!);
    await enableLldp(r1);
    await enableLldp(r2);
    await enableLldp(sw);

    const swN = sw.getLldpAgent().getNeighbors();
    expect(swN.length).toBe(2);
    const r1N = r1.getLldpAgent().getNeighbors();
    expect(r1N.length).toBe(1);
    expect(r1N[0].systemName).toBe('SW');
  });

  it('frame on the wire uses the IEEE multicast and ethertype 0x88cc', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    r1.setEventBus(bus);
    r2.setEventBus(bus);
    const cable = new Cable('w');
    cable.setEventBus(bus);
    cable.connect(r1.getPort('GigabitEthernet0/1')!,
                  r2.getPort('GigabitEthernet0/1')!);

    let seen: { dst: string; ether: number } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      if (e.payload.frame.etherType === ETHERTYPE_LLDP) {
        seen = {
          dst: e.payload.frame.dstMAC.toString().toLowerCase(),
          ether: e.payload.frame.etherType,
        };
      }
    });
    await enableLldp(r1);
    await enableLldp(r2);

    expect(seen).not.toBeNull();
    expect(seen!.dst).toBe(LLDP_MULTICAST_MAC);
    expect(seen!.ether).toBe(ETHERTYPE_LLDP);
  });
});
