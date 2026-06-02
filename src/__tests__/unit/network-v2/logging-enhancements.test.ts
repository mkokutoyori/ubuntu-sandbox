import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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
    expect(out).toMatch(/%SEC_LOGIN-6.+connection from 10\.0\.0\.1:\d+ accepted on port 22/);
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
