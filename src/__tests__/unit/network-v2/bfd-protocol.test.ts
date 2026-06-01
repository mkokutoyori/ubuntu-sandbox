import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  UDP_PORT_BFD_CONTROL, detectionTimeMs, defaultSession,
} from '@/network/bfd/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('BFD — pure helpers', () => {
  it('detectionTimeMs follows RFC 5880 formula', () => {
    const s = defaultSession('GigabitEthernet0/0', '10.0.0.2');
    s.desiredMinTxUs = 1_000_000;
    s.remoteMinRxUs = 1_000_000;
    s.detectMultiplier = 3;
    expect(detectionTimeMs(s)).toBe(3000);
  });

  it('detectionTimeMs honours the larger of local TX and remote RX', () => {
    const s = defaultSession('GigabitEthernet0/0', '10.0.0.2');
    s.desiredMinTxUs = 100_000;
    s.remoteMinRxUs = 500_000;
    s.detectMultiplier = 5;
    expect(detectionTimeMs(s)).toBe(2500);
  });
});

describe('BFD — single-side session', () => {
  it('ensureSession creates a Down session with a unique discriminator', () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');
    const s = r.getBfdAgent().getSession('GigabitEthernet0/0', '10.0.0.2');
    expect(s).toBeDefined();
    expect(s!.state).toBe('down');
    expect(s!.localDiscriminator).toBeGreaterThan(0);
  });
});

describe('BFD — two-side handshake brings session Up', () => {
  it('mutual ensureSession on cabled routers reaches Up via Down→Init→Up', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    r1.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');
    r2.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.1');

    r1.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');
    r2.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.1');
    r1.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');

    expect(r1.getBfdAgent().getSession('GigabitEthernet0/0', '10.0.0.2')?.state).toBe('up');
    expect(r2.getBfdAgent().getSession('GigabitEthernet0/0', '10.0.0.1')?.state).toBe('up');
  });
});

describe('BFD — wire format', () => {
  it('control packets use UDP/3784 with bfd payload', async () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); sw.setEventBus(bus);
    const cable = new Cable('c');
    cable.setEventBus(bus);

    let seen: { dport: number; bfdVersion: number; state: string } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as {
        protocol?: number;
        payload?: { type?: string; destinationPort?: number; payload?: { type?: string; version?: number; state?: string } }
      } | undefined;
      const udp = ipPkt?.payload;
      if (udp?.type === 'udp' && udp.destinationPort === UDP_PORT_BFD_CONTROL) {
        const bfd = udp.payload;
        if (bfd?.type === 'bfd') {
          seen = { dport: udp.destinationPort, bfdVersion: bfd.version!, state: bfd.state! };
        }
      }
    });
    cable.connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');

    expect(seen).not.toBeNull();
    expect(seen!.dport).toBe(UDP_PORT_BFD_CONTROL);
    expect(seen!.bfdVersion).toBe(1);
    expect(['down', 'init', 'up']).toContain(seen!.state);
  });
});

describe('BFD — reactive bus', () => {
  it('bfd.session.changed fires on Down→Init→Up transitions', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    const transitions: Array<{ deviceId: string; oldState: string; newState: string }> = [];
    bus.subscribe('bfd.session.changed', (e) => transitions.push(e.payload));
    r1.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');
    r2.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.1');
    r1.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');
    r2.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.1');
    r1.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');
    expect(transitions.some(t => t.deviceId === r1.id && t.newState === 'init')).toBe(true);
    expect(transitions.some(t => t.deviceId === r1.id && t.newState === 'up')).toBe(true);
  });
});

describe('BFD — link-down brings session down', () => {
  it('losing the link transitions an Up session to Down with path-down diag', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r1.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');
    r2.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.1');
    r1.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');
    expect(r1.getBfdAgent().getSession('GigabitEthernet0/0', '10.0.0.2')?.state).toBe('up');
    r1.getPort('GigabitEthernet0/0')!.setUp(false);
    const s = r1.getBfdAgent().getSession('GigabitEthernet0/0', '10.0.0.2');
    expect(s?.state).toBe('down');
    expect(s?.localDiag).toBe('path-down');
  });
});

describe('BFD — admin-down', () => {
  it('setAdmin(false) drives the session to admin-down', () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');
    r.getBfdAgent().setAdmin('GigabitEthernet0/0', '10.0.0.2', false);
    expect(r.getBfdAgent().getSession('GigabitEthernet0/0', '10.0.0.2')?.state).toBe('admin-down');
  });
});

describe('BFD — Cisco↔Huawei interop', () => {
  it('vendor-neutral BFD brings the session Up between Cisco and Huawei', async () => {
    const bus = new EventBus();
    const cisco = new CiscoRouter('CSCO');
    const huawei = new HuaweiRouter('HW');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cisco.setEventBus(bus); huawei.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cisco.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(huawei.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/1')!);
    cisco.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    huawei.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    cisco.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');
    huawei.getBfdAgent().ensureSession('GE0/0/0', '10.0.0.1');
    cisco.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');
    huawei.getBfdAgent().ensureSession('GE0/0/0', '10.0.0.1');
    cisco.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');

    expect(cisco.getBfdAgent().getSession('GigabitEthernet0/0', '10.0.0.2')?.state).toBe('up');
    expect(huawei.getBfdAgent().getSession('GE0/0/0', '10.0.0.1')?.state).toBe('up');
  });
});

describe('BFD — show bfd neighbors', () => {
  it('renders the session table from live agent state', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('bfd neighbor 10.0.0.2');
    await r1.executeCommand('end');

    r2.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.1');
    r1.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.2');
    r2.getBfdAgent().ensureSession('GigabitEthernet0/0', '10.0.0.1');

    const out = await r1.executeCommand('show bfd neighbors');
    expect(out).toMatch(/10\.0\.0\.2/);
    expect(out).toMatch(/GigabitEthernet0\/0/);
  });
});
