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
      topic: 'port.link.up',
      payload: { deviceId: r.id, hostname: 'R', portName: 'GigabitEthernet0/0' },
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
  it('one bus subscription captures Cisco, Huawei, Linux and Windows entries', async () => {
    const bus = new EventBus();
    const cisco = new CiscoRouter('CSCO');
    const huawei = new HuaweiRouter('HUWI');
    const lnx = new LinuxServer('linux-server', 'LNX');
    const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
    cisco.setEventBus(bus); huawei.setEventBus(bus);
    lnx.setEventBus(bus); win.setEventBus(bus);
    lnx.powerOn(); win.powerOn();

    const entries: Array<{ deviceId: string; tag: string; message: string }> = [];
    bus.subscribe('device.syslog.entry', (e) => {
      const p = e.payload as { deviceId: string; tag: string; message: string };
      entries.push({ deviceId: p.deviceId, tag: p.tag, message: p.message });
    });

    bus.publish({
      topic: 'port.link.up',
      payload: { deviceId: cisco.id, hostname: 'CSCO', portName: 'GigabitEthernet0/0' },
    });
    bus.publish({
      topic: 'port.link.up',
      payload: { deviceId: huawei.id, hostname: 'HUWI', portName: 'GigabitEthernet0/0/0' },
    });
    lnx.getPort('eth0')!.setUp(false);
    await win.executeCommand(
      'netsh advfirewall firewall add rule name=Block-9999 dir=in action=block protocol=TCP localport=9999');
    win.auditPolicy.set('Filtering Platform Packet Drop', { success: true, failure: true });
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
  it('a port-security violation lands as %PORT_SECURITY-2-PSECURE_VIOLATION', async () => {
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
        mac: new MACAddress('00:11:22:33:44:55'), mode: 'shutdown', action: 'shutdown',
      },
    });
    bus.publish({
      topic: 'port.security.errdisable.set',
      payload: { deviceId: r.id, portName: 'GigabitEthernet0/0', mac: new MACAddress('00:11:22:33:44:55') },
    });

    const out = await Promise.resolve(r.executeCommand('show logging'));
    expect(out).toMatch(/%PORT_SECURITY-2-PSECURE_VIOLATION:.+MAC address 00:11:22:33:44:55/);
    expect(out).toMatch(/%PM-2-ERR_DISABLE:.+err-disabled/);
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
  it('une connexion TCP nue sur le 22 n\'annonce AUCUNE session SSH', async () => {
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
    await Promise.resolve(srv.executeCommand('logging buffered 8000 informational'));
    await Promise.resolve(srv.executeCommand('ip domain-name lab.local'));
    await Promise.resolve(srv.executeCommand('crypto key generate rsa modulus 2048'));
    await Promise.resolve(srv.executeCommand('end'));

    cli.getTcpStack().connect('10.0.0.2', 22);
    const out = await Promise.resolve(srv.executeCommand('show logging'));
    expect(out).toContain('Log Buffer');
    expect(out, 'aucune session n\'est etablie').not.toContain('SSH2_SESSION');
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
    // `log` est REQUIS : IOS n'ecrit un %SEC-*-IPACCESSLOGP que pour une ACE
    // qui le porte. Avant le lot ACL palier 1, la ligne sortait pour tout
    // refus, marque ou non — ce qui rendait le mot-cle sans effet.
    await Promise.resolve(srv.executeCommand('access-list 100 deny tcp any any eq 22 log'));
    await Promise.resolve(srv.executeCommand('access-list 100 permit ip any any'));
    await Promise.resolve(srv.executeCommand('interface GigabitEthernet0/0'));
    await Promise.resolve(srv.executeCommand('ip access-group 100 in'));
    await Promise.resolve(srv.executeCommand('exit'));
    await Promise.resolve(srv.executeCommand('logging buffered 8000 debugging'));
    await Promise.resolve(srv.executeCommand('end'));

    cli.getTcpStack().connect('10.0.0.2', 22);
    const out = await Promise.resolve(srv.executeCommand('show logging'));
    expect(out).toMatch(/%SEC-4-IPACCESSLOGP: list 100 denied tcp 10\.0\.0\.1\(\d+\) -> 10\.0\.0\.2\(22\), 1 packet/);
  });

  it('a Windows firewall Block rule emits a 5152 Security event', async () => {
    const bus = new EventBus();
    const cli = new LinuxPC('CLI');
    const win = new WindowsPC('windows-pc', 'PC', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cli.setEventBus(bus); win.setEventBus(bus); sw.setEventBus(bus);
    cli.powerOn(); win.powerOn();
    new Cable('a').connect(cli.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(win.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    cli.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    win.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    await win.executeCommand(
      'netsh advfirewall firewall add rule name=Block-22 dir=in action=block protocol=TCP localport=22');
    win.auditPolicy.set('Filtering Platform Packet Drop', { success: true, failure: true });

    cli.getTcpStack().connect('10.0.0.2', 22);
    const security = win.eventLog.getEntriesStructured('Security') ?? [];
    expect(security.some((e) =>
      e.eventId === 5152 &&
      e.message.includes('Filter: Block-22') &&
      e.message.includes('10.0.0.2:22'),
    )).toBe(true);
  });

  it('Huawei : une connexion TCP nue sur le 22 n\'annonce aucune session SSH', async () => {
    const bus = new EventBus();
    const cli = new HuaweiRouter('CLI');
    const srv = new HuaweiRouter('SRV');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cli.setEventBus(bus); srv.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cli.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(srv.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/2')!);
    cli.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    srv.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    await Promise.resolve(srv.executeCommand('system-view'));
    await Promise.resolve(srv.executeCommand('rsa local-key-pair create'));
    await Promise.resolve(srv.executeCommand('quit'));

    cli.getTcpStack().connect('10.0.0.2', 22);
    const out = await Promise.resolve(srv.executeCommand('display logbuffer'));
    expect(out, 'aucune session n\'est etablie').not.toMatch(/SSH.+AUTHENTICATION/);
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
    expect(out).toMatch(/%LINK-3-UPDOWN:.+GigabitEthernet0\/0.+state to up/);
    expect(out).toMatch(/%LINK-3-UPDOWN:.+GigabitEthernet0\/0.+state to down/);
  });

  it('a TCP segment dropped for no-listener writes nothing at all', async () => {
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
    expect(out).not.toContain('Segment dropped');
    expect(out).not.toContain('%TCP-4');
  });
});
