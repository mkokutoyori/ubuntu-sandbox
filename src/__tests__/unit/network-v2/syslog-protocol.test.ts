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
  UDP_PORT_SYSLOG, SYSLOG_FACILITY, SYSLOG_SEVERITY,
  priValue, severityFromLogLevel, shouldForward, bsdTimestamp, formatBsdSyslog,
} from '@/network/syslog/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});


async function addressViaCli(
  device: { executeCommand(c: string): Promise<string> }, iface: string, ip: string,
): Promise<void> {
  for (const line of [
    'enable', 'configure terminal', `interface ${iface}`,
    `ip address ${ip} 255.255.255.0`, 'no shutdown', 'end',
  ]) await device.executeCommand(line);
}

describe('Syslog — pure helpers', () => {
  it('priValue follows RFC 3164 facility*8 + severity', async () => {
    expect(priValue(SYSLOG_FACILITY.local7, SYSLOG_SEVERITY.informational)).toBe(23 * 8 + 6);
    expect(priValue(SYSLOG_FACILITY.kern, SYSLOG_SEVERITY.emergency)).toBe(0);
  });

  it('severityFromLogLevel maps internal log levels to syslog severities', async () => {
    expect(severityFromLogLevel('debug')).toBe('debugging');
    expect(severityFromLogLevel('info')).toBe('informational');
    expect(severityFromLogLevel('warn')).toBe('warning');
    expect(severityFromLogLevel('error')).toBe('error');
  });

  it('shouldForward respects the configured threshold (lower number is higher priority)', async () => {
    expect(shouldForward('informational', 'error')).toBe(true);
    expect(shouldForward('informational', 'informational')).toBe(true);
    expect(shouldForward('informational', 'debugging')).toBe(false);
    expect(shouldForward('warning', 'informational')).toBe(false);
    expect(shouldForward('warning', 'warning')).toBe(true);
  });

  it('formatBsdSyslog produces the canonical <pri>TIMESTAMP HOSTNAME TAG: MSG shape', async () => {
    const ts = bsdTimestamp(Date.UTC(2025, 0, 5, 13, 22, 7));
    const out = formatBsdSyslog({
      type: 'syslog',
      facility: SYSLOG_FACILITY.local7, severity: SYSLOG_SEVERITY.informational,
      hostname: 'R1', tag: '%SYS-6-RESTART',
      message: 'Reload', timestamp: ts,
    });
    expect(out).toBe(`<190>Jan  5 13:22:07 R1 %SYS-6-RESTART: Reload`);
  });
});

describe('Syslog — server management', () => {
  it('addServer / removeServer publish syslog.server.changed', async () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    r.setEventBus(bus);
    const events: Array<{ serverIp: string; added: boolean }> = [];
    bus.subscribe('syslog.server.changed', (e) => events.push(e.payload));
    r.getSyslogAgent().addServer('10.0.0.99');
    r.getSyslogAgent().removeServer('10.0.0.99');
    expect(events).toEqual([
      { deviceId: r.id, hostname: r.getHostname(), serverIp: '10.0.0.99', added: true },
      { deviceId: r.id, hostname: r.getHostname(), serverIp: '10.0.0.99', added: false },
    ]);
  });

  it('listServers returns the configured collectors sorted by IP', async () => {
    const r = new CiscoRouter('R1');
    r.getSyslogAgent().addServer('10.0.0.20');
    r.getSyslogAgent().addServer('10.0.0.10');
    expect(r.getSyslogAgent().listServers().map(s => s.ip)).toEqual(['10.0.0.10', '10.0.0.20']);
  });
});

describe('Syslog — wire format', () => {
  it('forwarded logs ride UDP/514 with a syslog payload', async () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    // A real peer at .99 so the now ARP-aware SyslogAgent (PRD audit #26)
    // can actually resolve a next-hop MAC instead of a fictitious address
    // that would just queue on a cold ARP cache and never reach the wire.
    const collector = new CiscoRouter('SYSLOG-SRV');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); collector.setEventBus(bus); sw.setEventBus(bus);
    const cable = new Cable('c');
    cable.setEventBus(bus);

    let seen: { dport: number; severity: number; tag: string; message: string } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as {
        protocol?: number;
        payload?: { type?: string; destinationPort?: number; payload?: { type?: string; severity?: number; tag?: string; message?: string } };
      } | undefined;
      const udp = ipPkt?.payload;
      if (udp?.type === 'udp' && udp.destinationPort === UDP_PORT_SYSLOG) {
        const syslog = udp.payload;
        if (syslog?.type === 'syslog') {
          seen = { dport: udp.destinationPort, severity: syslog.severity!, tag: syslog.tag!, message: syslog.message! };
        }
      }
    });
    cable.connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(collector.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    await addressViaCli(r, 'GigabitEthernet0/0', '10.0.0.1');
    await addressViaCli(collector, 'GigabitEthernet0/0', '10.0.0.99');
    r.getSyslogAgent().addServer('10.0.0.99');
    r.getSyslogAgent().sendImmediate('notification', '%SYS-5-RESTART',
      'Configuration changed by console');

    expect(seen).not.toBeNull();
    expect(seen!.dport).toBe(UDP_PORT_SYSLOG);
    expect(seen!.severity).toBe(SYSLOG_SEVERITY.notification);
    expect(seen!.message).toBe('Configuration changed by console');
    expect(seen!.tag).toMatch(/SYS-5-RESTART/);
  });
});

describe('Syslog — reactive bus', () => {
  it('publishes syslog.packet.sent on every successful forward', async () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); sw.setEventBus(bus);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await addressViaCli(r, 'GigabitEthernet0/0', '10.0.0.1');
    r.getSyslogAgent().addServer('10.0.0.99');
    const sent: Array<{ serverIp: string; severity: string }> = [];
    bus.subscribe('syslog.packet.sent', (e) => sent.push(e.payload));
    r.getSyslogAgent().sendImmediate('warning', '%SYS-4-CONFIG_RESOLVE_FAILURE', 'Test warning');
    r.getSyslogAgent().sendImmediate('error', '%LINK-3-UPDOWN', 'Test error');
    expect(sent.length).toBe(2);
    expect(sent[0].serverIp).toBe('10.0.0.99');
    expect(sent[0].severity).toBe('warning');
    expect(sent[1].severity).toBe('error');
  });

  it('drops messages below the configured threshold', async () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); sw.setEventBus(bus);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    await addressViaCli(r, 'GigabitEthernet0/0', '10.0.0.1');
    r.getSyslogAgent().addServer('10.0.0.99', { severityThreshold: 'warning' });
    const sent: Array<{ severity: string }> = [];
    const dropped: Array<{ reason: string }> = [];
    bus.subscribe('syslog.packet.sent', (e) => sent.push(e.payload));
    bus.subscribe('syslog.packet.dropped', (e) => dropped.push(e.payload));
    r.getSyslogAgent().sendImmediate('informational', '%SYS-6-LOGGINGHOST_STARTSTOP', 'informational - should drop');
    r.getSyslogAgent().sendImmediate('warning', '%SYS-4-CONFIG_RESOLVE_FAILURE', 'warning - should pass');
    expect(sent.length).toBe(1);
    expect(sent[0].severity).toBe('warning');
    expect(dropped.some(d => d.reason === 'threshold')).toBe(true);
  });
});

describe('Syslog — IOS CLI mirrors into the agent', () => {
  it('`logging host X` provisions the SyslogAgent through the existing LoggingConfig', async () => {
    const r = new CiscoRouter('R1');
    await addressViaCli(r, 'GigabitEthernet0/0', '10.0.0.1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging host 10.0.0.99');
    await r.executeCommand('logging trap warnings');
    await r.executeCommand('end');
    const servers = r.getSyslogAgent().listServers();
    expect(servers.length).toBe(1);
    expect(servers[0].ip).toBe('10.0.0.99');
    expect(servers[0].severityThreshold).toBe('warning');
  });

  it('`no logging host X` retires the server', async () => {
    const r = new CiscoRouter('R1');
    await addressViaCli(r, 'GigabitEthernet0/0', '10.0.0.1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging host 10.0.0.99');
    await r.executeCommand('no logging host 10.0.0.99');
    await r.executeCommand('end');
    expect(r.getSyslogAgent().listServers().length).toBe(0);
  });
});

describe('Syslog — vendor-neutral', () => {
  it('Huawei router also forwards logs via UDP/514', async () => {
    const bus = new EventBus();
    const r = new HuaweiRouter('HW');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); sw.setEventBus(bus);
    new Cable('c').connect(r.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/1')!);
    for (const line of [
      'system-view', 'interface GE0/0/0',
      'ip address 10.0.0.1 255.255.255.0', 'undo shutdown', 'quit', 'quit',
    ]) await r.executeCommand(line);
    r.getSyslogAgent().addServer('10.0.0.99');
    const sent: Array<{ message: string }> = [];
    bus.subscribe('syslog.packet.sent', (e) => sent.push(e.payload));
    r.getSyslogAgent().sendImmediate('informational', '%SYS-6-RESTART', 'system started');
    expect(sent.length).toBe(1);
    expect(sent[0].message).toBe('system started');
  });
});

describe('Syslog — switch as source', () => {
  it('CiscoSwitch also exposes a SyslogAgent and forwards its own logs', async () => {
    const bus = new EventBus();
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    sw1.setEventBus(bus); sw2.setEventBus(bus);
    new Cable('c').connect(sw1.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
    await addressViaCli(sw1, 'Vlan1', '10.0.0.1');
    await addressViaCli(sw2, 'Vlan1', '10.0.0.99');
    sw1.getSyslogAgent().addServer('10.0.0.99');
    const sent: Array<{ deviceId: string }> = [];
    bus.subscribe('syslog.packet.sent', (e) => sent.push(e.payload));
    sw1.getSyslogAgent().sendImmediate('informational', '%SYS-6-RESTART', 'switch ready');
    expect(sent.some(s => s.deviceId === sw1.id)).toBe(true);
  });
});
