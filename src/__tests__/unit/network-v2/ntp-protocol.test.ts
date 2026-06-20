import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { UDP_PORT_NTP, computeOffsetMs } from '@/network/ntp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function configIp(r: CiscoRouter | HuaweiRouter, iface: string, ip: string, mask: string): void {
  r.getPort(iface)!.configureIP(new IPAddress(ip), new SubnetMask(mask));
}

describe('NTP — pure helpers', () => {
  it('computeOffsetMs implements the (t2-t1 + t3-t4) / 2 formula', () => {
    const r = computeOffsetMs(0, 100, 110, 20);
    expect(r.offset).toBeCloseTo(95);
    expect(r.delay).toBeCloseTo(10);
  });

  it('a fresh router is unsynced at stratum 16', () => {
    const r = new CiscoRouter('R1');
    expect(r.getNtpAgent().isSynced()).toBe(false);
    expect(r.getNtpAgent().getStratum()).toBe(16);
  });
});

describe('NTP — server mode', () => {
  it('ntp master sets the server flag and lowers stratum to 8', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ntp master');
    await r.executeCommand('end');
    expect(r.getNtpAgent().getConfig().serverMode).toBe(true);
    expect(r.getNtpAgent().getStratum()).toBe(8);
  });

  it('ntp master 3 sets stratum 3', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ntp master 3');
    await r.executeCommand('end');
    expect(r.getNtpAgent().getStratum()).toBe(3);
  });
});

describe('NTP — client / server exchange', () => {
  it('client syncs from server: stratum drops, association reach updates', async () => {
    const bus = new EventBus();
    const server = new CiscoRouter('NTP-SRV');
    const client = new CiscoRouter('NTP-CLI');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    server.setEventBus(bus); client.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    configIp(server, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0');
    configIp(client, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0');

    await server.executeCommand('enable');
    await server.executeCommand('configure terminal');
    await server.executeCommand('ntp master 3');
    await server.executeCommand('end');

    await client.executeCommand('enable');
    await client.executeCommand('configure terminal');
    await client.executeCommand('ntp server 10.0.0.1');
    await client.executeCommand('end');

    expect(client.getNtpAgent().isSynced()).toBe(true);
    expect(client.getNtpAgent().getStratum()).toBe(4);
    const a = client.getNtpAgent().getConfig().associations.get('10.0.0.1');
    expect(a?.synced).toBe(true);
    expect(a?.stratum).toBe(3);
    expect(a?.reach).toBeGreaterThan(0);
  });

  it('reactive bus: ntp.packet.sent + ntp.packet.received + ntp.synced fire', async () => {
    const bus = new EventBus();
    const server = new CiscoRouter('NTP-SRV');
    const client = new CiscoRouter('NTP-CLI');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    server.setEventBus(bus); client.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    configIp(server, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0');
    configIp(client, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0');

    const sent: string[] = [];
    const received: string[] = [];
    const synced: Array<{ serverIp: string; newStratum: number }> = [];
    bus.subscribe('ntp.packet.sent', (e) => sent.push(e.payload.serverIp));
    bus.subscribe('ntp.packet.received', (e) => received.push(e.payload.fromIp));
    bus.subscribe('ntp.synced', (e) => synced.push(e.payload));

    await server.executeCommand('enable');
    await server.executeCommand('configure terminal');
    await server.executeCommand('ntp master 4');
    await server.executeCommand('end');

    await client.executeCommand('enable');
    await client.executeCommand('configure terminal');
    await client.executeCommand('ntp server 10.0.0.1');
    await client.executeCommand('end');

    expect(sent).toContain('10.0.0.1');
    expect(received.length).toBeGreaterThan(0);
    expect(synced.some(s => s.serverIp === '10.0.0.1' && s.newStratum === 5)).toBe(true);
  });
});

describe('NTP — wire format', () => {
  it('frames use UDP/123 between client and server', async () => {
    const bus = new EventBus();
    const server = new CiscoRouter('NTP-SRV');
    const client = new CiscoRouter('NTP-CLI');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    server.setEventBus(bus); client.setEventBus(bus); sw.setEventBus(bus);
    const ca = new Cable('a'); const cb = new Cable('b');
    ca.setEventBus(bus); cb.setEventBus(bus);
    ca.connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    cb.connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    configIp(server, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0');
    configIp(client, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0');

    const seen: Array<{ src: number; dst: number }> = [];
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as { protocol?: number; payload?: { sourcePort?: number; destinationPort?: number } } | undefined;
      if (ipPkt?.protocol === 17 && (ipPkt.payload?.destinationPort === UDP_PORT_NTP || ipPkt.payload?.sourcePort === UDP_PORT_NTP)) {
        seen.push({ src: ipPkt.payload?.sourcePort ?? 0, dst: ipPkt.payload?.destinationPort ?? 0 });
      }
    });

    await server.executeCommand('enable');
    await server.executeCommand('configure terminal');
    await server.executeCommand('ntp master');
    await server.executeCommand('end');

    await client.executeCommand('enable');
    await client.executeCommand('configure terminal');
    await client.executeCommand('ntp server 10.0.0.1');
    await client.executeCommand('end');

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every(s => s.src === UDP_PORT_NTP && s.dst === UDP_PORT_NTP)).toBe(true);
  });
});

describe('NTP — show commands', () => {
  it('show ntp status reports synchronized after sync', async () => {
    const bus = new EventBus();
    const server = new CiscoRouter('NTP-SRV');
    const client = new CiscoRouter('NTP-CLI');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    server.setEventBus(bus); client.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    configIp(server, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0');
    configIp(client, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0');
    await server.executeCommand('enable');
    await server.executeCommand('configure terminal');
    await server.executeCommand('ntp master');
    await server.executeCommand('end');
    await client.executeCommand('enable');
    await client.executeCommand('configure terminal');
    await client.executeCommand('ntp server 10.0.0.1');
    await client.executeCommand('end');
    const status = await client.executeCommand('show ntp status');
    expect(status).toMatch(/Clock is synchronized/);
    expect(status).toMatch(/stratum 9/);
  });

  it('show ntp lists the configured association', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ntp server 10.0.0.1');
    await r.executeCommand('end');
    const out = await r.executeCommand('show ntp');
    expect(out).toMatch(/10\.0\.0\.1/);
  });

  it('running-config emits ntp server lines', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ntp server 10.0.0.1 prefer');
    await r.executeCommand('ntp master 5');
    await r.executeCommand('end');
    const cfg = r.getNtpAgent().runningConfigLines();
    expect(cfg).toContain('ntp server 10.0.0.1 prefer');
    expect(cfg).toContain('ntp master');
  });
});

describe('NTP — Cisco↔Huawei interop', () => {
  it('Huawei client syncs from Cisco server (vendor-neutral protocol)', async () => {
    const bus = new EventBus();
    const cisco = new CiscoRouter('CSCO1');
    const huawei = new HuaweiRouter('HW1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cisco.setEventBus(bus); huawei.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cisco.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(huawei.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/2')!);
    configIp(cisco, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0');
    configIp(huawei, 'GE0/0/0', '10.0.0.2', '255.255.255.0');

    cisco.getNtpAgent().setServerMode(true);
    cisco.getNtpAgent().setLocalStratum(3);

    huawei.getNtpAgent().addServer('10.0.0.1');

    expect(huawei.getNtpAgent().isSynced()).toBe(true);
    expect(huawei.getNtpAgent().getStratum()).toBe(4);
  });
});

describe('NTP — agent clock', () => {
  it('agent.now() reflects the synced offset', async () => {
    const bus = new EventBus();
    const server = new CiscoRouter('NTP-SRV');
    const client = new CiscoRouter('NTP-CLI');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    server.setEventBus(bus); client.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    configIp(server, 'GigabitEthernet0/0', '10.0.0.1', '255.255.255.0');
    configIp(client, 'GigabitEthernet0/0', '10.0.0.2', '255.255.255.0');

    await server.executeCommand('enable');
    await server.executeCommand('configure terminal');
    await server.executeCommand('ntp master');
    await server.executeCommand('end');

    await client.executeCommand('enable');
    await client.executeCommand('configure terminal');
    await client.executeCommand('ntp server 10.0.0.1');
    await client.executeCommand('end');

    const offset = client.getNtpAgent().getOffsetMs();
    const skew = client.getNtpAgent().now() - Date.now();
    expect(Math.abs(skew - offset)).toBeLessThan(5);
  });
});

describe('NTP — disable / remove', () => {
  it('no ntp server removes the association', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ntp server 10.0.0.1');
    expect(r.getNtpAgent().getConfig().associations.has('10.0.0.1')).toBe(true);
    await r.executeCommand('no ntp server 10.0.0.1');
    expect(r.getNtpAgent().getConfig().associations.has('10.0.0.1')).toBe(false);
  });

  it('no ntp master clears server mode and resets stratum to 16', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ntp master 5');
    expect(r.getNtpAgent().getStratum()).toBe(5);
    await r.executeCommand('no ntp master');
    expect(r.getNtpAgent().getConfig().serverMode).toBe(false);
    expect(r.getNtpAgent().getStratum()).toBe(16);
  });
});
