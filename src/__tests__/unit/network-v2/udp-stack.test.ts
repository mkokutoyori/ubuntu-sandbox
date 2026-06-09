import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { ReceivedUdpDatagram } from '@/network/udp/UdpStack';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function buildLan() {
  const bus = new EventBus();
  const cli = new LinuxPC('linux-pc', 'CLI');
  const srv = new LinuxPC('linux-pc', 'SRV');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  cli.setEventBus(bus); srv.setEventBus(bus); sw.setEventBus(bus);
  cli.powerOn(); srv.powerOn();
  new Cable('a').connect(cli.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
  new Cable('b').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  cli.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { bus, cli, srv, sw };
}

describe('EndHost — UdpStack (RFC 768)', () => {
  it('delivers a datagram host-to-host through a switch', async () => {
    const { cli, srv } = buildLan();
    const received: ReceivedUdpDatagram[] = [];
    srv.getUdpStack().listen(5353, (d) => { received.push(d); });

    const sent = await cli.getUdpStack().send({
      destinationIp: '10.0.0.2', destinationPort: 5353,
      payload: 'hello-udp', sourcePort: 40000,
    });

    expect(sent).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].payload).toBe('hello-udp');
    expect(received[0].sourceIp).toBe('10.0.0.1');
    expect(received[0].sourcePort).toBe(40000);
    expect(received[0].destinationPort).toBe(5353);
  });

  it('supports request/response via reply()', async () => {
    const { cli, srv } = buildLan();
    srv.getUdpStack().listen(53, (d) => { void d.reply(`echo:${d.payload}`); });

    const answers: unknown[] = [];
    const { port, dispose } = cli.getUdpStack().listenEphemeral((d) => { answers.push(d.payload); });
    const sent = await cli.getUdpStack().send({
      destinationIp: '10.0.0.2', destinationPort: 53,
      payload: 'query', sourcePort: port,
    });
    // reply() resolves ARP from cache (just learned) — flush microtasks
    await new Promise(r => setTimeout(r, 10));
    dispose();

    expect(sent).toBe(true);
    expect(answers).toEqual(['echo:query']);
  });

  it('emits udp.datagram.dropped(no-listener) and ICMP Port Unreachable for a closed port', async () => {
    const { bus, cli, srv } = buildLan();
    const drops: Array<{ deviceId: string; reason: string; destinationPort: number }> = [];
    bus.subscribe('udp.datagram.dropped', (e) => {
      drops.push({
        deviceId: e.payload.deviceId,
        reason: e.payload.reason,
        destinationPort: e.payload.destinationPort,
      });
    });
    const icmpErrors: Array<{ deviceId: string; reason: string }> = [];
    bus.subscribe('host.icmp.echo-failed', (e) => {
      icmpErrors.push({ deviceId: e.payload.deviceId, reason: e.payload.reason });
    });

    const sent = await cli.getUdpStack().send({
      destinationIp: '10.0.0.2', destinationPort: 9999, payload: 'x',
    });

    expect(sent).toBe(true);
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('no-listener');
    expect(drops[0].deviceId).toBe(srv.id);
    expect(drops[0].destinationPort).toBe(9999);
    // The sender received ICMP type 3 code 3 (Port Unreachable) back
    expect(icmpErrors.some(e => e.deviceId === cli.id && /code 3/.test(e.reason))).toBe(true);
  });

  it('returns false when no route exists to the destination', async () => {
    const { cli } = buildLan();
    const sent = await cli.getUdpStack().send({
      destinationIp: '192.168.99.99', destinationPort: 53, payload: 'x',
    });
    expect(sent).toBe(false);
  });

  it('delivers subnet broadcast to listeners without ICMP errors from silent hosts', async () => {
    const { bus, cli, srv, sw } = buildLan();
    const third = new WindowsPC('windows-pc', 'WIN');
    third.setEventBus(bus);
    third.powerOn();
    new Cable('c').connect(third.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    third.getPort('eth0')!.configureIP(new IPAddress('10.0.0.3'), new SubnetMask('255.255.255.0'));

    const got: string[] = [];
    srv.getUdpStack().listen(67, (d) => { got.push(`srv:${d.payload}`); });
    third.getUdpStack().listen(67, (d) => { got.push(`win:${d.payload}`); });

    const errors: string[] = [];
    bus.subscribe('udp.datagram.dropped', (e) => { errors.push(e.payload.reason); });

    const sent = await cli.getUdpStack().send({
      destinationIp: '10.0.0.255', destinationPort: 67, payload: 'discover',
    });

    expect(sent).toBe(true);
    expect(got.sort()).toEqual(['srv:discover', 'win:discover']);
    expect(errors).toEqual([]);
  });

  it('throws EADDRINUSE on duplicate bind and frees the port on dispose', () => {
    const { srv } = buildLan();
    const dispose = srv.getUdpStack().listen(123, () => {});
    expect(() => srv.getUdpStack().listen(123, () => {})).toThrow(/EADDRINUSE/);
    dispose();
    expect(() => srv.getUdpStack().listen(123, () => {})).not.toThrow();
  });

  it('allocates distinct ephemeral ports in the RFC 6335 range', () => {
    const { cli } = buildLan();
    const a = cli.getUdpStack().listenEphemeral(() => {});
    const b = cli.getUdpStack().listenEphemeral(() => {});
    expect(a.port).toBeGreaterThanOrEqual(49152);
    expect(b.port).toBeGreaterThanOrEqual(49152);
    expect(a.port).not.toBe(b.port);
    a.dispose(); b.dispose();
  });
});
