import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  UDP_PORT_GLBP, GLBP_MULTICAST_IP, GLBP_MULTICAST_MAC,
  glbpVirtualMac, compareCandidate, effectiveWeighting,
} from '@/network/glbp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function configureGlbp(r: CiscoRouter, iface: string, ip: string, mask: string, group: number, vip: string, priority?: number, preempt = false): Promise<void> {
  r.getPort(iface)!.configureIP(new IPAddress(ip), new SubnetMask(mask));
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand(`interface ${iface}`);
  await r.executeCommand(`glbp ${group} ip ${vip}`);
  if (priority !== undefined) await r.executeCommand(`glbp ${group} priority ${priority}`);
  if (preempt) await r.executeCommand(`glbp ${group} preempt`);
  await r.executeCommand('no shutdown');
  await r.executeCommand('end');
}

describe('GLBP — pure helpers', () => {
  it('glbpVirtualMac follows Cisco 0007.b400.XXYY formula', () => {
    expect(glbpVirtualMac(1, 1)).toBe('00:07:b4:00:01:01');
    expect(glbpVirtualMac(10, 4)).toBe('00:07:b4:00:0a:04');
  });

  it('compareCandidate: higher priority wins, tie broken by higher IP', () => {
    expect(compareCandidate({ priority: 200, ip: '10.0.0.1' },
                             { priority: 100, ip: '10.0.0.99' })).toBeLessThan(0);
    expect(compareCandidate({ priority: 100, ip: '10.0.0.2' },
                             { priority: 100, ip: '10.0.0.1' })).toBeLessThan(0);
  });
});

describe('GLBP — single-speaker AVG election', () => {
  it('the only configured speaker becomes AVG', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    await configureGlbp(r, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 100);
    const g = r.getGlbpAgent().getGroup('GigabitEthernet0/0', 1);
    expect(g?.avgState).toBe('active');
    expect(g?.avgIp).toBe('10.0.0.1');
  });

  it('AVG self-assigns forwarder 1 with virtual MAC 0007.b400.01.01', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    await configureGlbp(r, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 100);
    const g = r.getGlbpAgent().getGroup('GigabitEthernet0/0', 1);
    const f1 = g?.forwarders.get(1);
    expect(f1?.vmac).toBe('00:07:b4:00:01:01');
    expect(f1?.state).toBe('active');
    expect(f1?.ownerIp).toBe('10.0.0.1');
  });
});

describe('GLBP — two-speaker AVG election', () => {
  it('higher priority router becomes AVG, the other Standby', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await configureGlbp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 200);
    await configureGlbp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);
    expect(r1.getGlbpAgent().getGroup('GigabitEthernet0/0', 1)?.avgState).toBe('active');
    expect(r2.getGlbpAgent().getGroup('GigabitEthernet0/0', 1)?.avgState).toBe('standby');
  });

  it('AVG assigns a forwarder number to the peer (AVF assignment)', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await configureGlbp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 200);
    await configureGlbp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);
    const g1 = r1.getGlbpAgent().getGroup('GigabitEthernet0/0', 1)!;
    const peerForwarder = [...g1.forwarders.values()].find(f => f.ownerIp === '10.0.0.2');
    expect(peerForwarder).toBeDefined();
    expect(peerForwarder!.forwarderNumber).toBeGreaterThanOrEqual(1);
    expect(peerForwarder!.forwarderNumber).toBeLessThanOrEqual(4);
    expect(peerForwarder!.vmac).toBe(glbpVirtualMac(1, peerForwarder!.forwarderNumber));
  });
});

describe('GLBP — wire format', () => {
  it('hello uses UDP/3222 to 224.0.0.102 with MAC 01:00:5e:00:00:66', async () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); sw.setEventBus(bus);
    const cable = new Cable('c');
    cable.setEventBus(bus);

    let seen: { sport: number; dport: number; ip: string; mac: string } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      const eth = e.payload.frame;
      const ipPkt = (eth.payload as unknown) as { protocol?: number; destinationIP?: { toString: () => string }; payload?: { type?: string; sourcePort?: number; destinationPort?: number } } | undefined;
      const udp = ipPkt?.payload;
      if (udp?.type === 'udp' && udp.destinationPort === UDP_PORT_GLBP) {
        seen = {
          sport: udp.sourcePort!, dport: udp.destinationPort!,
          ip: ipPkt!.destinationIP!.toString(),
          mac: eth.dstMAC.toString().toLowerCase(),
        };
      }
    });
    cable.connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    await configureGlbp(r, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254');
    expect(seen).not.toBeNull();
    expect(seen!.sport).toBe(UDP_PORT_GLBP);
    expect(seen!.dport).toBe(UDP_PORT_GLBP);
    expect(seen!.ip).toBe(GLBP_MULTICAST_IP);
    expect(seen!.mac).toBe(GLBP_MULTICAST_MAC);
  });
});

describe('GLBP — reactive bus', () => {
  it('glbp.avg.changed and glbp.avf.assigned fire on election', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    const avgs: Array<{ deviceId: string; newState: string }> = [];
    const avfs: Array<{ deviceId: string; forwarderNumber: number; ownerIp: string }> = [];
    bus.subscribe('glbp.avg.changed', (e) => avgs.push(e.payload));
    bus.subscribe('glbp.avf.assigned', (e) => avfs.push(e.payload));
    await configureGlbp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 200);
    await configureGlbp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);
    expect(avgs.some(e => e.deviceId === r1.id && e.newState === 'active')).toBe(true);
    expect(avfs.some(e => e.deviceId === r1.id && e.ownerIp === '10.0.0.2')).toBe(true);
  });
});

describe('GLBP — link-down behaviour', () => {
  it('link-down brings the AVG back to Init', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    await configureGlbp(r, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254');
    expect(r.getGlbpAgent().getGroup('GigabitEthernet0/0', 1)?.avgState).toBe('active');
    r.getPort('GigabitEthernet0/0')!.setUp(false);
    expect(r.getGlbpAgent().getGroup('GigabitEthernet0/0', 1)?.avgState).toBe('init');
  });
});

describe('GLBP — load balancing', () => {
  it('round-robin cycles through active forwarders', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await configureGlbp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 200);
    await configureGlbp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);
    const g = r1.getGlbpAgent().getGroup('GigabitEthernet0/0', 1)!;
    const r2Forwarder = [...g.forwarders.values()].find(f => f.ownerIp === '10.0.0.2')!;
    r2Forwarder.state = 'active';
    const m1 = r1.getGlbpAgent().nextForwarderMacForClient('GigabitEthernet0/0', 1, '10.0.0.50');
    const m2 = r1.getGlbpAgent().nextForwarderMacForClient('GigabitEthernet0/0', 1, '10.0.0.51');
    const m3 = r1.getGlbpAgent().nextForwarderMacForClient('GigabitEthernet0/0', 1, '10.0.0.52');
    expect(new Set([m1, m2, m3]).size).toBe(2);
    expect(m1).not.toBe(m2);
  });

  it('host-dependent returns same vmac for same client across calls', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await configureGlbp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 200);
    await configureGlbp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);
    r1.getGlbpAgent().setLoadBalancing('GigabitEthernet0/0', 1, 'host-dependent');
    const g = r1.getGlbpAgent().getGroup('GigabitEthernet0/0', 1)!;
    [...g.forwarders.values()].forEach(f => { f.state = 'active'; });
    const a = r1.getGlbpAgent().nextForwarderMacForClient('GigabitEthernet0/0', 1, '10.0.0.77');
    const b = r1.getGlbpAgent().nextForwarderMacForClient('GigabitEthernet0/0', 1, '10.0.0.77');
    expect(a).toBe(b);
  });
});

describe('GLBP — show glbp', () => {
  it('show glbp reports State is Active', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    await configureGlbp(r, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 100);
    const out = await r.executeCommand('show glbp');
    expect(out).toMatch(/State is Active/);
    expect(out).toMatch(/Virtual IP address is 10\.0\.0\.254/);
    expect(out).toMatch(/Forwarder 1/);
  });

  it('show glbp brief renders the elected role', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await configureGlbp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 200);
    await configureGlbp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);
    const out = await r2.executeCommand('show glbp brief');
    expect(out).toMatch(/Standby/);
  });
});

describe('GLBP — weighting tracking (interface objects)', () => {
  it('glbp weighting track lowers the forwarder weighting while the tracked link is down, restores it on up', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    await configureGlbp(r, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 100);

    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('glbp 1 weighting track GigabitEthernet0/1 decrement 80');
    await r.executeCommand('end');

    const g = r.getGlbpAgent().getGroup('GigabitEthernet0/0', 1)!;
    expect(effectiveWeighting(g)).toBe(20);
    const own = [...g.forwarders.values()].find(f => f.ownerIp === '10.0.0.1');
    expect(own?.weighting).toBe(20);

    new Cable('t').connect(r.getPort('GigabitEthernet0/1')!, sw.getPort('FastEthernet0/1')!);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/1');
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');

    expect(effectiveWeighting(g)).toBe(100);
    expect([...g.forwarders.values()].find(f => f.ownerIp === '10.0.0.1')?.weighting).toBe(100);
  });
});
