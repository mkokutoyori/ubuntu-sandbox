import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { UDP_PORT_HSRP, HSRP_MULTICAST_V1, compareSpeaker, hsrpVirtualMac } from '@/network/hsrp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function configureHsrp(r: CiscoRouter, iface: string, ip: string, mask: string, group: number, vip: string, priority?: number, preempt = false): Promise<void> {
  r.getPort(iface)!.configureIP(new IPAddress(ip), new SubnetMask(mask));
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand(`interface ${iface}`);
  await r.executeCommand(`standby ${group} ip ${vip}`);
  if (priority !== undefined) await r.executeCommand(`standby ${group} priority ${priority}`);
  if (preempt) await r.executeCommand(`standby ${group} preempt`);
  await r.executeCommand('no shutdown');
  await r.executeCommand('end');
}

describe('HSRP — pure helpers', () => {
  it('compareSpeaker: higher priority wins, tie broken by higher IP', () => {
    expect(compareSpeaker({ priority: 200, ip: '10.0.0.1' },
                           { priority: 100, ip: '10.0.0.99' })).toBeLessThan(0);
    expect(compareSpeaker({ priority: 100, ip: '10.0.0.2' },
                           { priority: 100, ip: '10.0.0.1' })).toBeLessThan(0);
    expect(compareSpeaker({ priority: 100, ip: '10.0.0.1' },
                           { priority: 100, ip: '10.0.0.1' })).toBe(0);
  });

  it('hsrpVirtualMac formula matches the standard prefix', () => {
    expect(hsrpVirtualMac(1, 1)).toBe('0000.0c07.ac01');
    expect(hsrpVirtualMac(42, 1)).toBe('0000.0c07.ac2a');
    expect(hsrpVirtualMac(1, 2)).toBe('0000.0c9f.f001');
  });

  it('hsrpVirtualMac covers the full group range of each version', () => {
    expect(hsrpVirtualMac(0, 1)).toBe('0000.0c07.ac00');
    expect(hsrpVirtualMac(255, 1)).toBe('0000.0c07.acff');
    expect(hsrpVirtualMac(0, 2)).toBe('0000.0c9f.f000');
    expect(hsrpVirtualMac(256, 2)).toBe('0000.0c9f.f100');
    expect(hsrpVirtualMac(4095, 2)).toBe('0000.0c9f.ffff');
  });

  it('hsrpVirtualMac rejects out-of-range groups instead of emitting a malformed MAC', () => {
    expect(() => hsrpVirtualMac(256, 1)).toThrow(RangeError);
    expect(() => hsrpVirtualMac(4096, 2)).toThrow(RangeError);
    expect(() => hsrpVirtualMac(-1, 1)).toThrow(RangeError);
    expect(() => hsrpVirtualMac(1.5, 1)).toThrow(RangeError);
  });
});

describe('HSRP — group number range enforcement (real IOS behavior)', () => {
  async function configMode(r: CiscoRouter, iface: string): Promise<void> {
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand(`interface ${iface}`);
  }

  it('rejects a group above 255 while the interface runs HSRP version 1', async () => {
    const r = new CiscoRouter('R1');
    await configMode(r, 'GigabitEthernet0/0');
    const out = await r.executeCommand('standby 300 ip 10.0.0.254');
    expect(out).toMatch(/out of range/i);
    expect(r.getHsrpAgent().getGroup('GigabitEthernet0/0', 300)).toBeUndefined();
  });

  it('accepts groups up to 4095 once standby version 2 is set', async () => {
    const r = new CiscoRouter('R1');
    await configMode(r, 'GigabitEthernet0/0');
    await r.executeCommand('standby version 2');
    const out = await r.executeCommand('standby 300 ip 10.0.0.254');
    expect(out).not.toMatch(/out of range/i);
    expect(r.getHsrpAgent().getGroup('GigabitEthernet0/0', 300)).toBeDefined();
    const tooBig = await r.executeCommand('standby 4096 ip 10.0.0.254');
    expect(tooBig).toMatch(/out of range/i);
  });

  it('refuses to fall back to version 1 while groups above 255 exist', async () => {
    const r = new CiscoRouter('R1');
    await configMode(r, 'GigabitEthernet0/0');
    await r.executeCommand('standby version 2');
    await r.executeCommand('standby 300 ip 10.0.0.254');
    const out = await r.executeCommand('standby version 1');
    expect(out).toMatch(/cannot change to version 1/i);
    const show = await r.executeCommand('end')
      .then(() => r.executeCommand('show standby'));
    expect(show).toMatch(/version 2/i);
  });
});

describe('HSRP — single-speaker election', () => {
  it('the only configured speaker becomes Active', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await configureHsrp(r, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 100);
    const g = r.getHsrpAgent().getGroup('GigabitEthernet0/0', 1);
    expect(g?.state).toBe('active');
    expect(g?.activeRouterIp).toBe('10.0.0.1');
  });

  it('show standby reports State is Active', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await configureHsrp(r, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 100);
    const out = await r.executeCommand('show standby');
    expect(out).toMatch(/State is Active/);
    expect(out).toMatch(/Active router is local/);
  });
});

describe('HSRP — two-speaker election', () => {
  it('higher priority router becomes Active, the other Standby', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    await configureHsrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 110, true);
    await configureHsrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);

    const g1 = r1.getHsrpAgent().getGroup('GigabitEthernet0/0', 1);
    const g2 = r2.getHsrpAgent().getGroup('GigabitEthernet0/0', 1);
    expect(g1?.state).toBe('active');
    expect(g2?.state).toBe('standby');
  });
});

describe('HSRP — Learn state (RFC 2281 §5, VIP learned from hellos)', () => {
  async function configLearn(r: CiscoRouter, ip: string, group: number): Promise<void> {
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress(ip), new SubnetMask('255.255.255.0'));
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand(`standby ${group} ip`);
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');
  }

  it('standby <grp> ip with no address puts the group in Learn (VIP unknown)', async () => {
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await configLearn(r2, '10.0.0.2', 1);

    const g2 = r2.getHsrpAgent().getGroup('GigabitEthernet0/0', 1);
    expect(g2?.state).toBe('learn');
    expect(g2?.vip).toBeNull();
  });

  it('a Learn router adopts the VIP from the active router and leaves Learn', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);

    await configLearn(r2, '10.0.0.2', 1);
    expect(r2.getHsrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('learn');

    await configureHsrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 110, true);

    const g2 = r2.getHsrpAgent().getGroup('GigabitEthernet0/0', 1);
    expect(g2?.vip).toBe('10.0.0.254');
    expect(g2?.state).not.toBe('learn');
    expect(g2?.state).not.toBe('init');
  });

  it('without preempt, a later higher-priority router does NOT displace the incumbent (IOS default)', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    // R1 (priority 100) is active first; R2 joins later with 200 but no preempt.
    await configureHsrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 100);
    await configureHsrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 200);

    expect(r1.getHsrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('active');
    expect(r2.getHsrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('standby');
  });

  it('with preempt, a later higher-priority router takes over', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    await configureHsrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 100);
    await configureHsrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 200, true);

    expect(r2.getHsrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('active');
    expect(r1.getHsrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).not.toBe('active');
  });

  it('on equal priority, higher IP wins when the challenger preempts', async () => {
    // Without preempt a live active is never displaced (IOS default) —
    // the IP tie-break only decides a contested election, so the
    // higher-IP challenger here is configured with preempt.
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    await configureHsrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 100);
    await configureHsrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100, true);

    const g1 = r1.getHsrpAgent().getGroup('GigabitEthernet0/0', 1);
    const g2 = r2.getHsrpAgent().getGroup('GigabitEthernet0/0', 1);
    expect(g2?.state).toBe('active');
    // The displaced router re-elects itself standby only after the
    // stale standby entry ages out (hold timer), like real IOS.
    expect(g1?.state).not.toBe('active');
  });

  it('without preempt, equal-priority higher IP does NOT displace the incumbent', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    await configureHsrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 100);
    await configureHsrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);

    expect(r1.getHsrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('active');
    expect(r2.getHsrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('standby');
  });
});

describe('HSRP — reactive events', () => {
  it('hsrp.state.changed fires when election runs', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    const changes: Array<{ deviceId: string; newState: string }> = [];
    bus.subscribe('hsrp.state.changed', (e) => changes.push(e.payload));
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    await configureHsrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 200);
    await configureHsrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);

    expect(changes.some(c => c.deviceId === r1.id && c.newState === 'active')).toBe(true);
    expect(changes.some(c => c.deviceId === r2.id && c.newState === 'standby')).toBe(true);
  });

  it('hsrp.packet.received fires on peer hello', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    const received: Array<{ deviceId: string; fromIp: string }> = [];
    bus.subscribe('hsrp.packet.received', (e) => received.push(e.payload));
    await configureHsrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 110);
    await configureHsrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);

    expect(received.some(r => r.deviceId === r2.id && r.fromIp === '10.0.0.1')).toBe(true);
  });

  it('hsrp.active.changed fires with the elected active IP', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    const actives: Array<{ deviceId: string; activeIp: string | null }> = [];
    bus.subscribe('hsrp.active.changed', (e) => actives.push(e.payload));
    await configureHsrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 200);
    await configureHsrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);

    expect(actives.some(a => a.deviceId === r2.id && a.activeIp === '10.0.0.1')).toBe(true);
  });
});

describe('HSRP — wire format', () => {
  it('hello uses UDP/1985 to the all-routers multicast', async () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); sw.setEventBus(bus);
    const cable = new Cable('c');
    cable.setEventBus(bus);

    let seen: { srcPort: number; dstPort: number; dstIp: string } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as { protocol?: number; payload?: { sourcePort?: number; destinationPort?: number }; destinationIP?: { toString: () => string } } | undefined;
      if (ipPkt?.protocol === 17 && ipPkt.payload?.destinationPort === UDP_PORT_HSRP) {
        seen = {
          srcPort: ipPkt.payload.sourcePort ?? 0,
          dstPort: ipPkt.payload.destinationPort,
          dstIp: ipPkt.destinationIP?.toString() ?? '',
        };
      }
    });
    cable.connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await configureHsrp(r, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254');

    expect(seen).not.toBeNull();
    expect(seen!.srcPort).toBe(UDP_PORT_HSRP);
    expect(seen!.dstPort).toBe(UDP_PORT_HSRP);
    expect(seen!.dstIp).toBe(HSRP_MULTICAST_V1);
  });
});

describe('HSRP — link-down behaviour', () => {
  it('link-down clears the Active election (back to Init)', async () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); sw.setEventBus(bus);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await configureHsrp(r, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 100);
    expect(r.getHsrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('active');
    r.getPort('GigabitEthernet0/0')!.setUp(false);
    expect(r.getHsrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('init');
  });
});

describe('HSRP — show standby reports peer info', () => {
  it('Active router IP is reported on the standby side', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    await configureHsrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 200);
    await configureHsrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);
    const out = await r2.executeCommand('show standby');
    expect(out).toMatch(/State is Standby/);
    expect(out).toMatch(/Active router is 10\.0\.0\.1/);
  });

  it('show standby brief lists the elected role', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    await configureHsrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 200);
    await configureHsrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);
    const out = await r2.executeCommand('show standby brief');
    expect(out).toMatch(/Standby/);
    expect(out).toMatch(/10\.0\.0\.1/);
  });
});

describe('HSRP — group version stability (regression)', () => {
  it('an implicit ensureGroup (setter path) never downgrades a v2 group to v1', async () => {
    const r = new CiscoRouter('R1');
    const agent = r.getHsrpAgent();
    // Explicit v2 group…
    agent.ensureGroup('GigabitEthernet0/0', 1, 2);
    expect(agent.getGroup('GigabitEthernet0/0', 1)!.version).toBe(2);
    // …then a setter that re-ensures the group WITHOUT a version:
    agent.setPriority('GigabitEthernet0/0', 1, 150);
    // The old implementation defaulted version to 1 here and silently
    // downgraded the group.
    expect(agent.getGroup('GigabitEthernet0/0', 1)!.version).toBe(2);
  });
});
