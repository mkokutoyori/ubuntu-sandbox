import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { DTP_MULTICAST_MAC, ETHERTYPE_DTP, resolveOperationalMode } from '@/network/dtp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('DTP — pure resolution matrix', () => {
  it('static modes win over any peer', () => {
    expect(resolveOperationalMode('access', 'trunk')).toBe('access');
    expect(resolveOperationalMode('trunk', 'access')).toBe('trunk');
  });
  it('nonegotiate is always trunk', () => {
    expect(resolveOperationalMode('nonegotiate', null)).toBe('trunk');
    expect(resolveOperationalMode('nonegotiate', 'access')).toBe('trunk');
  });
  it('auto + auto = access', () => {
    expect(resolveOperationalMode('dynamic-auto', 'dynamic-auto')).toBe('access');
  });
  it('auto + desirable = trunk', () => {
    expect(resolveOperationalMode('dynamic-auto', 'dynamic-desirable')).toBe('trunk');
    expect(resolveOperationalMode('dynamic-desirable', 'dynamic-auto')).toBe('trunk');
  });
  it('desirable + desirable = trunk', () => {
    expect(resolveOperationalMode('dynamic-desirable', 'dynamic-desirable')).toBe('trunk');
  });
  it('peer access pulls dynamic down to access', () => {
    expect(resolveOperationalMode('dynamic-desirable', 'access')).toBe('access');
  });
  it('peer trunk pulls dynamic up to trunk', () => {
    expect(resolveOperationalMode('dynamic-auto', 'trunk')).toBe('trunk');
  });
  it('no peer info → dynamic stays access', () => {
    expect(resolveOperationalMode('dynamic-auto', null)).toBe('access');
    expect(resolveOperationalMode('dynamic-desirable', null)).toBe('access');
  });
});

describe('DTP — negotiation across a cable', () => {
  it('auto/auto remains access on both sides', async () => {
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await s1.executeCommand('enable');
    await s1.executeCommand('configure terminal');
    await s1.executeCommand('interface FastEthernet0/1');
    await s1.executeCommand('switchport mode dynamic auto');
    await s1.executeCommand('end');
    await s2.executeCommand('enable');
    await s2.executeCommand('configure terminal');
    await s2.executeCommand('interface FastEthernet0/1');
    await s2.executeCommand('switchport mode dynamic auto');
    await s2.executeCommand('end');
    new Cable('w').connect(s1.getPort('FastEthernet0/1')!,
                            s2.getPort('FastEthernet0/1')!);
    expect(s1.getDtpAgent().getOperationalMode('FastEthernet0/1')).toBe('access');
    expect(s2.getDtpAgent().getOperationalMode('FastEthernet0/1')).toBe('access');
    expect(s1.getSwitchportConfig('FastEthernet0/1')!.mode).toBe('access');
  });

  it('desirable/auto negotiates trunk on both sides', async () => {
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await s1.executeCommand('enable');
    await s1.executeCommand('configure terminal');
    await s1.executeCommand('interface FastEthernet0/1');
    await s1.executeCommand('switchport mode dynamic desirable');
    await s1.executeCommand('end');
    await s2.executeCommand('enable');
    await s2.executeCommand('configure terminal');
    await s2.executeCommand('interface FastEthernet0/1');
    await s2.executeCommand('switchport mode dynamic auto');
    await s2.executeCommand('end');
    new Cable('w').connect(s1.getPort('FastEthernet0/1')!,
                            s2.getPort('FastEthernet0/1')!);
    expect(s1.getDtpAgent().getOperationalMode('FastEthernet0/1')).toBe('trunk');
    expect(s2.getDtpAgent().getOperationalMode('FastEthernet0/1')).toBe('trunk');
    expect(s1.getSwitchportConfig('FastEthernet0/1')!.mode).toBe('trunk');
    expect(s2.getSwitchportConfig('FastEthernet0/1')!.mode).toBe('trunk');
  });

  it('desirable/desirable negotiates trunk', async () => {
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    for (const sw of [s1, s2]) {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode dynamic desirable');
      await sw.executeCommand('end');
    }
    new Cable('w').connect(s1.getPort('FastEthernet0/1')!,
                            s2.getPort('FastEthernet0/1')!);
    expect(s1.getDtpAgent().getOperationalMode('FastEthernet0/1')).toBe('trunk');
    expect(s2.getDtpAgent().getOperationalMode('FastEthernet0/1')).toBe('trunk');
  });

  it('access/desirable keeps the access side access', async () => {
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await s1.executeCommand('enable');
    await s1.executeCommand('configure terminal');
    await s1.executeCommand('interface FastEthernet0/1');
    await s1.executeCommand('switchport mode access');
    await s1.executeCommand('end');
    await s2.executeCommand('enable');
    await s2.executeCommand('configure terminal');
    await s2.executeCommand('interface FastEthernet0/1');
    await s2.executeCommand('switchport mode dynamic desirable');
    await s2.executeCommand('end');
    new Cable('w').connect(s1.getPort('FastEthernet0/1')!,
                            s2.getPort('FastEthernet0/1')!);
    expect(s1.getDtpAgent().getOperationalMode('FastEthernet0/1')).toBe('access');
    expect(s2.getDtpAgent().getOperationalMode('FastEthernet0/1')).toBe('access');
  });

  it('nonegotiate stops sending DTP frames and forces local trunk', async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    await s1.executeCommand('enable');
    await s1.executeCommand('configure terminal');
    await s1.executeCommand('interface FastEthernet0/1');
    await s1.executeCommand('switchport mode trunk');
    await s1.executeCommand('switchport nonegotiate');
    await s1.executeCommand('end');
    expect(s1.getDtpAgent().getAdminMode('FastEthernet0/1')).toBe('nonegotiate');

    const sent: string[] = [];
    bus.subscribe('dtp.frame.sent', (e) => {
      if (e.payload.deviceId === s1.id) sent.push(e.payload.port);
    });
    new Cable('w').connect(s1.getPort('FastEthernet0/1')!,
                            s2.getPort('FastEthernet0/1')!);
    expect(sent.length).toBe(0);
    expect(s1.getDtpAgent().getOperationalMode('FastEthernet0/1')).toBe('trunk');
  });
});

describe('DTP — reactive events', () => {
  it('mode.changed fires when DTP turns a dynamic port into trunk', async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    const changes: Array<{ port: string; newOperationalMode: string; reason: string }> = [];
    bus.subscribe('dtp.mode.changed', (e) => changes.push(e.payload));

    await s1.executeCommand('enable');
    await s1.executeCommand('configure terminal');
    await s1.executeCommand('interface FastEthernet0/1');
    await s1.executeCommand('switchport mode dynamic desirable');
    await s1.executeCommand('end');
    await s2.executeCommand('enable');
    await s2.executeCommand('configure terminal');
    await s2.executeCommand('interface FastEthernet0/1');
    await s2.executeCommand('switchport mode dynamic auto');
    await s2.executeCommand('end');
    new Cable('w').connect(s1.getPort('FastEthernet0/1')!,
                            s2.getPort('FastEthernet0/1')!);

    expect(changes.some(c => c.newOperationalMode === 'trunk')).toBe(true);
  });

  it('link-down resets the peer state and may revert mode', async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    for (const sw of [s1, s2]) {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode dynamic desirable');
      await sw.executeCommand('end');
    }
    new Cable('w').connect(s1.getPort('FastEthernet0/1')!,
                            s2.getPort('FastEthernet0/1')!);
    expect(s1.getDtpAgent().getOperationalMode('FastEthernet0/1')).toBe('trunk');

    const linkChanges: Array<{ reason: string }> = [];
    bus.subscribe('dtp.mode.changed', (e) => {
      if (e.payload.deviceId === s1.id) linkChanges.push(e.payload);
    });

    s1.getPort('FastEthernet0/1')!.setUp(false);
    expect(s1.getDtpAgent().getOperationalMode('FastEthernet0/1')).toBe('access');
    expect(linkChanges.some(c => c.reason === 'link-down')).toBe(true);
  });
});

describe('DTP — wire format', () => {
  it('frames use the reserved multicast and ethertype 0x2004', async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    const cable = new Cable('w');
    cable.setEventBus(bus);

    let seen: { dst: string; ether: number } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      if (e.payload.frame.etherType === ETHERTYPE_DTP) {
        seen = {
          dst: e.payload.frame.dstMAC.toString().toLowerCase(),
          ether: e.payload.frame.etherType,
        };
      }
    });
    for (const sw of [s1, s2]) {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode dynamic desirable');
      await sw.executeCommand('end');
    }
    cable.connect(s1.getPort('FastEthernet0/1')!,
                  s2.getPort('FastEthernet0/1')!);

    expect(seen).not.toBeNull();
    expect(seen!.dst).toBe(DTP_MULTICAST_MAC);
    expect(seen!.ether).toBe(ETHERTYPE_DTP);
  });
});

describe('DTP — running-config + show dtp', () => {
  it('dynamic admin modes round-trip into running-config', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode dynamic auto');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode dynamic desirable');
    await sw.executeCommand('interface FastEthernet0/3');
    await sw.executeCommand('switchport nonegotiate');
    await sw.executeCommand('end');
    const r = sw.getRunningConfig();
    expect(r).toMatch(/interface FastEthernet0\/1[\s\S]*?switchport mode dynamic auto/);
    expect(r).toMatch(/interface FastEthernet0\/2[\s\S]*?switchport mode dynamic desirable/);
    expect(r).toMatch(/interface FastEthernet0\/3[\s\S]*?switchport nonegotiate/);
  });

  it('show dtp interface FastEthernet0/1 reports admin/operational state', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode dynamic desirable');
    await sw.executeCommand('end');
    const out = await sw.executeCommand('show dtp interface FastEthernet0/1');
    expect(out).toMatch(/DTP information for FastEthernet0\/1/);
    expect(out).toMatch(/DYN-DESIRABLE/);
  });

  it('show dtp lists each port with its admin / operational mode', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode dynamic auto');
    await sw.executeCommand('end');
    const out = await sw.executeCommand('show dtp');
    expect(out).toMatch(/Global DTP information/);
    expect(out).toMatch(/DYN-AUTO/);
  });
});

describe('DTP — peer aging (silent neighbour)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a negotiated trunk falls back to access when the peer goes silent past 5×hello', async () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    s1.setEventBus(bus); s2.setEventBus(bus);
    await s1.executeCommand('enable');
    await s1.executeCommand('configure terminal');
    await s1.executeCommand('interface FastEthernet0/1');
    await s1.executeCommand('switchport mode dynamic desirable');
    await s1.executeCommand('end');
    await s2.executeCommand('enable');
    await s2.executeCommand('configure terminal');
    await s2.executeCommand('interface FastEthernet0/1');
    await s2.executeCommand('switchport mode dynamic auto');
    await s2.executeCommand('end');
    new Cable('w').connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);
    expect(s1.getDtpAgent().getOperationalMode('FastEthernet0/1')).toBe('trunk');

    const reasons: string[] = [];
    bus.subscribe('dtp.mode.changed', (e) => reasons.push((e.payload as { reason: string }).reason));

    // Peer hangs while the link stays up — previously the stale
    // peerAdminMode kept the port operationally trunk forever.
    s2.getDtpAgent().stop();
    vi.advanceTimersByTime(5 * 30_000 + 6_000);

    expect(s1.getDtpAgent().getOperationalMode('FastEthernet0/1')).toBe('access');
    expect(reasons).toContain('peer-loss');
  });
});
