import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { IP_PROTO_VRRP, VRRP_MULTICAST_IP, compareCandidate, vrrpVirtualMac, masterDownIntervalMs } from '@/network/vrrp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function configureVrrp(r: CiscoRouter, iface: string, ip: string, mask: string, vrid: number, vip: string, priority?: number): Promise<void> {
  r.getPort(iface)!.configureIP(new IPAddress(ip), new SubnetMask(mask));
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand(`interface ${iface}`);
  await r.executeCommand(`vrrp ${vrid} ip ${vip}`);
  if (priority !== undefined) await r.executeCommand(`vrrp ${vrid} priority ${priority}`);
  await r.executeCommand('no shutdown');
  await r.executeCommand('end');
}

describe('VRRP — pure helpers', () => {
  it('compareCandidate: higher priority wins, tie broken by higher IP', () => {
    expect(compareCandidate({ priority: 200, ip: '10.0.0.1' },
                             { priority: 100, ip: '10.0.0.99' })).toBeLessThan(0);
    expect(compareCandidate({ priority: 100, ip: '10.0.0.2' },
                             { priority: 100, ip: '10.0.0.1' })).toBeLessThan(0);
  });

  it('vrrpVirtualMac matches the IANA prefix', () => {
    expect(vrrpVirtualMac(1)).toBe('00:00:5e:00:01:01');
    expect(vrrpVirtualMac(42)).toBe('00:00:5e:00:01:2a');
  });

  it('masterDownIntervalMs follows the RFC 5798 formula', () => {
    expect(masterDownIntervalMs(1, 100)).toBeCloseTo(3000 + ((256 - 100) / 256) * 1000, 0);
  });
});

describe('VRRP — single-speaker election', () => {
  it('the only configured speaker becomes Master', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await configureVrrp(r, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 100);
    const g = r.getVrrpAgent().getGroup('GigabitEthernet0/0', 1);
    expect(g?.state).toBe('master');
    expect(g?.masterIp).toBe('10.0.0.1');
  });

  it('show vrrp reports State is Master', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await configureVrrp(r, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 100);
    const out = await r.executeCommand('show vrrp');
    expect(out).toMatch(/State is Master/);
    expect(out).toMatch(/Master Router is local/);
  });
});

describe('VRRP — two-speaker election', () => {
  it('higher priority router becomes Master, the other Backup', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    await configureVrrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 110);
    await configureVrrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);

    expect(r1.getVrrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('master');
    expect(r2.getVrrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('backup');
  });

  it('VRRP preempts by default (RFC 5798): higher priority displaces master', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    await configureVrrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);
    expect(r2.getVrrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('master');
    await configureVrrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 200);
    expect(r1.getVrrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('master');
    expect(r2.getVrrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('backup');
  });
});

describe('VRRP — wire format', () => {
  it('advertisement uses IP protocol 112 to 224.0.0.18', async () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); sw.setEventBus(bus);
    const cable = new Cable('c');
    cable.setEventBus(bus);

    let seen: { proto: number; dst: string } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as { protocol?: number; destinationIP?: { toString: () => string } } | undefined;
      if (ipPkt?.protocol === IP_PROTO_VRRP) {
        seen = { proto: ipPkt.protocol, dst: ipPkt.destinationIP?.toString() ?? '' };
      }
    });
    cable.connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await configureVrrp(r, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254');

    expect(seen).not.toBeNull();
    expect(seen!.proto).toBe(IP_PROTO_VRRP);
    expect(seen!.dst).toBe(VRRP_MULTICAST_IP);
  });
});

describe('VRRP — reactive bus', () => {
  it('vrrp.state.changed and vrrp.master.changed fire on election', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    const states: Array<{ deviceId: string; newState: string }> = [];
    const masters: Array<{ deviceId: string; masterIp: string | null }> = [];
    bus.subscribe('vrrp.state.changed', (e) => states.push(e.payload));
    bus.subscribe('vrrp.master.changed', (e) => masters.push(e.payload));
    await configureVrrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 200);
    await configureVrrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);
    expect(states.some(s => s.deviceId === r2.id && s.newState === 'backup')).toBe(true);
    expect(masters.some(m => m.deviceId === r2.id && m.masterIp === '10.0.0.1')).toBe(true);
  });
});

describe('VRRP — link-down behaviour', () => {
  it('link-down brings the master back to Init', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await configureVrrp(r, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254');
    expect(r.getVrrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('master');
    r.getPort('GigabitEthernet0/0')!.setUp(false);
    expect(r.getVrrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('init');
  });
});

describe('VRRP — Cisco↔Huawei interop', () => {
  it('Cisco master, Huawei backup — vendor-neutral protocol', async () => {
    const bus = new EventBus();
    const cisco = new CiscoRouter('CSCO1');
    const huawei = new HuaweiRouter('HW1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cisco.setEventBus(bus); huawei.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cisco.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(huawei.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/2')!);

    cisco.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    huawei.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    cisco.getVrrpAgent().ensureGroup('GigabitEthernet0/0', 1);
    cisco.getVrrpAgent().setPriority('GigabitEthernet0/0', 1, 200);
    cisco.getVrrpAgent().setVip('GigabitEthernet0/0', 1, '10.0.0.254');

    huawei.getVrrpAgent().ensureGroup('GE0/0/0', 1);
    huawei.getVrrpAgent().setPriority('GE0/0/0', 1, 100);
    huawei.getVrrpAgent().setVip('GE0/0/0', 1, '10.0.0.254');

    expect(cisco.getVrrpAgent().getGroup('GigabitEthernet0/0', 1)?.state).toBe('master');
    expect(huawei.getVrrpAgent().getGroup('GE0/0/0', 1)?.state).toBe('backup');
  });
});

describe('VRRP — show vrrp reports peer master IP', () => {
  it('backup side reports the master IP', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    await configureVrrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 200);
    await configureVrrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);
    const out = await r2.executeCommand('show vrrp');
    expect(out).toMatch(/State is Backup/);
    expect(out).toMatch(/Master Router is 10\.0\.0\.1/);
  });

  it('show vrrp brief renders the elected role', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    await configureVrrp(r1, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', 1, '10.0.0.254', 200);
    await configureVrrp(r2, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0', 1, '10.0.0.254', 100);
    const out = await r2.executeCommand('show vrrp brief');
    expect(out).toMatch(/Backup/);
    expect(out).toMatch(/10\.0\.0\.1/);
  });
});
