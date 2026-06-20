import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('Logging — every LinuxLogManager write produces a device.syslog.entry', () => {
  it('a logKernel call on Linux fires device.syslog.entry with deviceId + severity', () => {
    const bus = new EventBus();
    const srv = new LinuxServer('linux-server', 'SRV');
    srv.setEventBus(bus);
    srv.powerOn();

    const entries: Array<{ tag: string; message: string; severity: string }> = [];
    bus.subscribeWhere('device.syslog.entry',
      (p) => (p as { deviceId?: string }).deviceId === srv.id,
      (e) => entries.push(e.payload as { tag: string; message: string; severity: string }));

    const port = srv.getPort('eth0')!;
    port.setUp(false);

    expect(entries.some(e => e.tag === 'kernel' && e.message.includes('Link is Down'))).toBe(true);
  });
});

describe('Logging — SyslogAgent forwards buffer entries to remote servers', () => {
  it('Cisco buffer event also lands on a remote syslog listener via UDP/514', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R');
    r.setEventBus(bus);
    r.getSyslogAgent().setEnabled(true);
    r.getSyslogAgent().addServer('10.99.99.99', { severityThreshold: 'debugging' });

    let drops = 0;
    bus.subscribeWhere('syslog.packet.dropped',
      (p) => (p as { deviceId?: string }).deviceId === r.id,
      () => { drops++; });

    bus.publish({
      topic: 'tcp.listener.changed',
      payload: { deviceId: r.id, hostname: 'R', localIp: '0.0.0.0', localPort: 8080, added: true },
    });

    expect(drops).toBeGreaterThan(0);
  });
});

describe('Logging — Linux interface link events land in kern.log', () => {
  it('toggling a port link writes Up/Down lines to /var/log/kern.log', async () => {
    const bus = new EventBus();
    const srv = new LinuxServer('linux-server', 'SRV');
    srv.setEventBus(bus);
    srv.powerOn();

    const port = srv.getPort('eth0')!;
    port.setUp(false);
    port.setUp(true);
    port.setUp(false);

    const kern = await srv.executeCommand('cat /var/log/kern.log');
    expect(kern).toMatch(/kernel.+eth0: Link is Up/);
    expect(kern).toMatch(/kernel.+eth0: Link is Down/);
  });
});

describe('Logging — unified device.syslog.entry across all device types', () => {
  it('one bus subscription captures Cisco, Huawei, Linux and Windows entries', () => {
    const bus = new EventBus();
    const cisco = new CiscoRouter('CSCO');
    const huawei = new HuaweiRouter('HUWI');
    const lnx = new LinuxServer('linux-server', 'LNX');
    const win = new WindowsPC('WIN', 0, 0);
    cisco.setEventBus(bus); huawei.setEventBus(bus);
    lnx.setEventBus(bus); win.setEventBus(bus);
    lnx.powerOn(); win.powerOn();

    const entries: Array<{ deviceId: string; tag: string; message: string }> = [];
    bus.subscribe('device.syslog.entry', (e) => {
      const p = e.payload as { deviceId: string; tag: string; message: string };
      entries.push({ deviceId: p.deviceId, tag: p.tag, message: p.message });
    });

    bus.publish({
      topic: 'tcp.listener.changed',
      payload: { deviceId: cisco.id, hostname: 'CSCO', localIp: '0.0.0.0', localPort: 9000, added: true },
    });
    bus.publish({
      topic: 'tcp.listener.changed',
      payload: { deviceId: huawei.id, hostname: 'HUWI', localIp: '0.0.0.0', localPort: 9001, added: true },
    });
    lnx.getPort('eth0')!.setUp(false);
    win.dynamicFirewallRules.set('Block-9999', {
      name: 'Block-9999', displayName: 'Block', enabled: true,
      action: 'Block', direction: 'Inbound', protocol: 'TCP',
      localPort: '9999', remotePort: 'Any', description: 'test',
    });
    bus.publish({
      topic: 'windows.firewall.drop',
      payload: {
        deviceId: win.id, hostname: 'WIN', ruleName: 'Block-9999',
        sourceIp: '10.0.0.1', destinationIp: '10.0.0.2',
        sourcePort: 49152, destinationPort: 9999,
        protocol: 'TCP', direction: 'Inbound',
      },
    });

    const byDevice = new Set(entries.map(e => e.deviceId));
    expect(byDevice.has(cisco.id)).toBe(true);
    expect(byDevice.has(huawei.id)).toBe(true);
    expect(byDevice.has(lnx.id)).toBe(true);
    expect(byDevice.has(win.id)).toBe(true);
  });
});

describe('Logging — Cisco port security violation goes to show logging', () => {
  it('a port-security violation lands as %PORT_SECURITY-2-CRITICAL', async () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R');
    r.setEventBus(bus);
    await Promise.resolve(r.executeCommand('enable'));
    await Promise.resolve(r.executeCommand('configure terminal'));
    await Promise.resolve(r.executeCommand('logging buffered 8000 debugging'));
    await Promise.resolve(r.executeCommand('end'));

    bus.publish({
      topic: 'port.security.violation',
      payload: {
        deviceId: r.id, portName: 'GigabitEthernet0/0',
        mac: '00:11:22:33:44:55', mode: 'shutdown', action: 'shutdown',
      },
    });
    bus.publish({
      topic: 'port.security.errdisable.set',
      payload: { deviceId: r.id, portName: 'GigabitEthernet0/0', mac: '00:11:22:33:44:55' },
    });

    const out = await Promise.resolve(r.executeCommand('show logging'));
    expect(out).toMatch(/%PORT_SECURITY-2-CRITICAL:.+MAC address 00:11:22:33:44:55/);
    expect(out).toMatch(/%PM-2-CRITICAL:.+err-disabled/);
  });
});

describe('Logging — Linux iptables drops appear in /var/log/kern.log', () => {
  it('a dropped INPUT packet writes a netfilter line to kern.log', async () => {
    const bus = new EventBus();
    const cli = new LinuxPC('CLI');
    const srv = new LinuxServer('linux-server', 'SRV');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cli.setEventBus(bus); srv.setEventBus(bus); sw.setEventBus(bus);
    cli.powerOn(); srv.powerOn();
    new Cable('a').connect(cli.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    cli.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    await srv.executeCommand('iptables -A INPUT -p tcp --dport 23 -j DROP');
    cli.getTcpStack().connect('10.0.0.2', 23);

    const kern = await srv.executeCommand('cat /var/log/kern.log');
    expect(kern).toMatch(/netfilter.+\[netfilter DROP\] IN=eth0.+SRC=10\.0\.0\.1 DST=10\.0\.0\.2 PROTO=TCP.+DPT=23/);
  });
});

describe('Logging — Cisco show logging buffers TCP/SSH events', () => {
  it('an SSH connection (port 22) lands in `show logging` buffer', async () => {
    const bus = new EventBus();
    const cli = new CiscoRouter('CLI');
    const srv = new CiscoRouter('SRV');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cli.setEventBus(bus); srv.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cli.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(srv.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    cli.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    srv.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    srv.executeCommand('configure terminal');
    srv.executeCommand('logging buffered 8000 informational');
    srv.executeCommand('end');

    cli.getTcpStack().connect('10.0.0.2', 22);
    const out = await Promise.resolve(srv.executeCommand('show logging'));
    expect(out).toContain('Log Buffer');
    expect(out).toMatch(/%SSH-5-NOTIFICATIONS:.+AUTHENTICATION.+from 10\.0\.0\.1:\d+ accepted on port 22/);
  });

  it('an inbound ACL deny on TCP lands in the show-logging buffer', async () => {
    const bus = new EventBus();
    const cli = new CiscoRouter('CLI');
    const srv = new CiscoRouter('SRV');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cli.setEventBus(bus); srv.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cli.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(srv.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    cli.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    srv.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    await Promise.resolve(srv.executeCommand('enable'));
    await Promise.resolve(srv.executeCommand('configure terminal'));
    await Promise.resolve(srv.executeCommand('access-list 100 deny tcp any any eq 22'));
    await Promise.resolve(srv.executeCommand('access-list 100 permit ip any any'));
    await Promise.resolve(srv.executeCommand('interface GigabitEthernet0/0'));
    await Promise.resolve(srv.executeCommand('ip access-group 100 in'));
    await Promise.resolve(srv.executeCommand('exit'));
    await Promise.resolve(srv.executeCommand('logging buffered 8000 debugging'));
    await Promise.resolve(srv.executeCommand('end'));

    cli.getTcpStack().connect('10.0.0.2', 22);
    const out = await Promise.resolve(srv.executeCommand('show logging'));
    expect(out).toMatch(/%SEC-4-WARNINGS:.+ACL denied inbound TCP/);
  });

  it('a Windows firewall Block rule emits a 5152 Security event', async () => {
    const bus = new EventBus();
    const cli = new LinuxPC('CLI');
    const win = new WindowsPC('PC', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cli.setEventBus(bus); win.setEventBus(bus); sw.setEventBus(bus);
    cli.powerOn(); win.powerOn();
    new Cable('a').connect(cli.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(win.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    cli.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    win.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    win.dynamicFirewallRules.set('Block-22', {
      name: 'Block-22', displayName: 'Block SSH',
      enabled: true, action: 'Block', direction: 'Inbound',
      protocol: 'TCP', localPort: '22', remotePort: 'Any', description: 'test',
    });

    cli.getTcpStack().connect('10.0.0.2', 22);
    const security = win.eventLog.getEntriesStructured('Security') ?? [];
    expect(security.some((e) =>
      e.eventId === 5152 &&
      e.message.includes('Filter: Block-22') &&
      e.message.includes('10.0.0.2:22'),
    )).toBe(true);
  });

  it('Huawei `display logbuffer` renders SSH/AUTHENTICATION dynamically', async () => {
    const bus = new EventBus();
    const cli = new HuaweiRouter('CLI');
    const srv = new HuaweiRouter('SRV');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cli.setEventBus(bus); srv.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cli.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(srv.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/2')!);
    cli.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    srv.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    cli.getTcpStack().connect('10.0.0.2', 22);
    const out = await Promise.resolve(srv.executeCommand('display logbuffer'));
    expect(out).toMatch(/%01SSH\/5\/NOTIFICATIONS:.+AUTHENTICATION.+from 10\.0\.0\.1/);
  });

  it('Cisco show logging captures interface link up/down as %LINK-3', async () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R');
    r.setEventBus(bus);
    await Promise.resolve(r.executeCommand('enable'));
    await Promise.resolve(r.executeCommand('configure terminal'));
    await Promise.resolve(r.executeCommand('logging buffered 8000 debugging'));
    await Promise.resolve(r.executeCommand('end'));

    const port = r.getPort('GigabitEthernet0/0')!;
    port.setUp(false);
    port.setUp(true);
    port.setUp(false);

    const out = await Promise.resolve(r.executeCommand('show logging'));
    expect(out).toMatch(/%LINK-3-ERRORS:.+GigabitEthernet0\/0.+state to up/);
    expect(out).toMatch(/%LINK-3-ERRORS:.+GigabitEthernet0\/0.+state to down/);
  });

  it('a TCP segment dropped for no-listener lands as a warning', async () => {
    const bus = new EventBus();
    const cli = new CiscoRouter('CLI');
    const srv = new CiscoRouter('SRV');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cli.setEventBus(bus); srv.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cli.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(srv.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    cli.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    srv.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    srv.executeCommand('configure terminal');
    srv.executeCommand('logging buffered 8000 debugging');
    srv.executeCommand('end');

    cli.getTcpStack().connect('10.0.0.2', 9999);
    const out = await Promise.resolve(srv.executeCommand('show logging'));
    expect(out).toMatch(/%TCP-4-WARNINGS:.+Segment dropped \(no-listener\)/);
  });
});
