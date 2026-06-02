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

describe('Logging — Linux iptables drops appear in /var/log/kern.log', () => {
  it('a dropped INPUT packet writes a netfilter line to kern.log', async () => {
    const bus = new EventBus();
    const cli = new LinuxPC('CLI');
    const srv = new LinuxServer('linux-server', 'SRV');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cli.setEventBus(bus); srv.setEventBus(bus); sw.setEventBus(bus);
    cli.powerOn(); srv.powerOn();
    new Cable('a').connect(cli.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
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
    new Cable('a').connect(cli.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(srv.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
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
    new Cable('a').connect(cli.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(srv.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
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
    new Cable('a').connect(cli.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(win.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
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
    new Cable('a').connect(cli.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(srv.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/1')!);
    cli.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    srv.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    cli.getTcpStack().connect('10.0.0.2', 22);
    const out = await Promise.resolve(srv.executeCommand('display logbuffer'));
    expect(out).toMatch(/%01SSH\/5\/NOTIFICATIONS:.+AUTHENTICATION.+from 10\.0\.0\.1/);
  });

  it('a TCP segment dropped for no-listener lands as a warning', async () => {
    const bus = new EventBus();
    const cli = new CiscoRouter('CLI');
    const srv = new CiscoRouter('SRV');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cli.setEventBus(bus); srv.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cli.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(srv.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
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
