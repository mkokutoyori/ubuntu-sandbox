import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { TcpSocket } from '@/network/tcp/TcpStack';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('EndHost — TcpStack v2', () => {
  it('exposes getTcpStack() and drives a 3-way handshake between two LinuxPCs', () => {
    const bus = new EventBus();
    const cli = new LinuxPC('CLI');
    const srv = new LinuxPC('SRV');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cli.setEventBus(bus); srv.setEventBus(bus); sw.setEventBus(bus);
    cli.powerOn(); srv.powerOn();
    new Cable('a').connect(cli.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    cli.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    let accepted: TcpSocket | null = null;
    srv.getTcpStack().listen(7000, { onAccept: (s) => { accepted = s; } });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7000);
    expect(clientSocket).not.toBeNull();
    expect(clientSocket!.state).toBe('established');
    expect(accepted).not.toBeNull();
    expect(accepted!.state).toBe('established');
  });

  it('SSH on port 22 is now owned by the v2 stack', () => {
    const bus = new EventBus();
    const srv = new LinuxPC('SRV');
    srv.setEventBus(bus);
    srv.powerOn();
    expect(srv.getTcpStack().listListeners().some(l => l.localPort === 22)).toBe(true);
  });
});
