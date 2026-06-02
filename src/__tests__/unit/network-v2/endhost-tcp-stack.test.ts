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
    new Cable('a').connect(cli.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
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

  it('legacy listenTcp on port 22 is not stolen by v2 cohabitation', () => {
    const bus = new EventBus();
    const srv = new LinuxPC('SRV');
    srv.setEventBus(bus);
    srv.powerOn();
    expect(srv.getTcpStack().hasInterest(
      {
        type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 40,
        identification: 0, flags: 0, fragmentOffset: 0,
        ttl: 64, protocol: 6, headerChecksum: 0,
        sourceIP: new IPAddress('10.0.0.1'),
        destinationIP: new IPAddress('10.0.0.2'),
        payload: {
          type: 'tcp', sourcePort: 49152, destinationPort: 22,
          sequence: 0, acknowledgement: 0, dataOffset: 5,
          flags: { fin: false, syn: true, rst: false, psh: false, ack: false, urg: false, ece: false, cwr: false },
          window: 65535, checksum: 0, urgentPointer: 0, options: [], payload: undefined,
        },
      },
      new IPAddress('10.0.0.1'),
    )).toBe(false);
  });
});
