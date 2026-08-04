/**
 * PRD-Port-Forwarding.md Phase 5 — Linux `iptables -j DNAT` port forwarding
 * actually delivers real traffic.
 *
 * Before this fix, only the IP half of `--to-destination ip:port` was ever
 * consumed (the port was silently dropped) and the IPv4 header checksum was
 * the only one ever recomputed after rewriting an address — the TCP/UDP
 * checksum, which covers the address via the pseudo-header, was left
 * pointing at the pre-NAT address, so the very first SYN (or any UDP
 * datagram with a real checksum) was silently rejected as bad-checksum by
 * the receiving TcpStack. These tests drive a real packet through a genuine
 * `LinuxServer` gateway (`sysctl net.ipv4.ip_forward=1` +
 * `iptables -t nat -A PREROUTING ... -j DNAT --to-destination`) to a
 * separate internal server actually listening.
 *
 * The TCP tests deliberately stop at "the server accepts the redirected
 * SYN on the right port", not "the client's socket reaches established":
 * this engine has no reply-path un-NAT/conntrack (PRD-Iptables-UFW.md's
 * own already-documented, explicitly out-of-scope limitation — confirmed
 * empirically here too, not just for the same-host case that document
 * names), so the server's SYN-ACK leaves with its own real address
 * (192.168.10.10:80) instead of the public one the client dialed
 * (203.0.113.1:8080), and TcpStack's socket demux — an exact
 * (localIp,localPort,remoteIp,remotePort) match — never recognizes it as
 * the client's pending connection. UDP has no such demux requirement
 * (`udpBind`'s listener accepts a datagram from any source), so the round
 * trip genuinely completes: the internal server can reply straight to the
 * client's real address and the client receives it, real checksum and all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';
import type { TcpSocket } from '@/network/tcp/TcpStack';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const OUTSIDE_IP = '203.0.113.2';
const GW_OUTSIDE_IP = '203.0.113.1';
const GW_INSIDE_IP = '192.168.10.1';
const SRV_IP = '192.168.10.10';
const PUBLIC_PORT = 8080;
const INTERNAL_PORT = 80;

interface Lab { outside: LinuxPC; gw: LinuxServer; srv: LinuxServer; }

async function buildLab(protocol: 'tcp' | 'udp'): Promise<Lab> {
  const outside = new LinuxPC('linux-pc', 'OUTSIDE');
  const gw = new LinuxServer('linux-server', 'GW');
  const srv = new LinuxServer('linux-server', 'SRV');

  outside.configureInterface('eth0', new IPAddress(OUTSIDE_IP), new SubnetMask('255.255.255.0'));
  gw.configureInterface('eth0', new IPAddress(GW_OUTSIDE_IP), new SubnetMask('255.255.255.0'));
  gw.configureInterface('eth1', new IPAddress(GW_INSIDE_IP), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(SRV_IP), new SubnetMask('255.255.255.0'));

  outside.setDefaultGateway(new IPAddress(GW_OUTSIDE_IP));
  srv.setDefaultGateway(new IPAddress(GW_INSIDE_IP));

  new Cable('c1').connect(outside.getPort('eth0')!, gw.getPort('eth0')!);
  new Cable('c2').connect(gw.getPort('eth1')!, srv.getPort('eth0')!);

  await gw.executeCommand('sysctl -w net.ipv4.ip_forward=1');
  await gw.executeCommand(
    `iptables -t nat -A PREROUTING -p ${protocol} --dport ${PUBLIC_PORT} -j DNAT --to-destination ${SRV_IP}:${INTERNAL_PORT}`,
  );

  return { outside, gw, srv };
}

describe('PRD-Port-Forwarding.md Phase 5 — Linux iptables DNAT port forwarding (TCP)', () => {
  it('a real SYN reaches the internal server on the redirected port', async () => {
    const { outside, srv } = await buildLab('tcp');
    let acceptedState: string | null = null;
    let acceptedLocalPort: number | null = null;
    let acceptedRemoteIp: string | null = null;
    srv.getTcpStack().listen(INTERNAL_PORT, {
      onAccept: (s) => {
        acceptedState = s.state;
        acceptedLocalPort = s.localPort;
        acceptedRemoteIp = s.remoteIp;
      },
    });

    // The SYN-ACK the server sends back leaves with its own real address
    // (192.168.10.10:80), not the public one the client dialed — so the
    // client's TcpStack never recognizes it as belonging to this pending
    // connection and (correctly, per RFC 9293 §3.10.7.1) RSTs it, tearing
    // the server's socket back down by the time connect() returns. The
    // assertions below capture the state at accept time, which is what
    // actually proves the SYN was delivered and demultiplexed correctly.
    const clientSocket = outside.getTcpStack().connect(GW_OUTSIDE_IP, PUBLIC_PORT);

    expect(acceptedLocalPort).toBe(INTERNAL_PORT);
    expect(acceptedRemoteIp).toBe(OUTSIDE_IP);
    expect(acceptedState).toBe('syn-received');
    expect(clientSocket!.state).toBe('syn-sent');
  });
});

describe('PRD-Port-Forwarding.md Phase 5 — Linux iptables DNAT port forwarding (UDP)', () => {
  it('a real datagram reaches the internal server on the redirected port', async () => {
    const { outside, srv } = await buildLab('udp');
    const received: { payload: string; srcIp: string }[] = [];
    srv.udpBind(INTERNAL_PORT, (d) => received.push({
      payload: d.udp.payload as string, srcIp: d.sourceIP.toString(),
    }));

    const sent = outside.sendUdpDatagram(new IPAddress(GW_OUTSIDE_IP), PUBLIC_PORT, 40000, 'hello', 5);

    expect(sent).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].payload).toBe('hello');
    expect(received[0].srcIp).toBe(OUTSIDE_IP);
  });

  it('the internal server can reply directly to the external client', async () => {
    const { outside, srv } = await buildLab('udp');
    srv.udpBind(INTERNAL_PORT, (d) => {
      srv.sendUdpDatagram(d.sourceIP as IPAddress, d.udp.sourcePort, INTERNAL_PORT, 'pong', 4);
    });
    const received: string[] = [];
    outside.udpBind(40000, (d) => received.push(d.udp.payload as string));

    outside.sendUdpDatagram(new IPAddress(GW_OUTSIDE_IP), PUBLIC_PORT, 40000, 'ping', 4);

    expect(received).toEqual(['pong']);
  });
});

describe('PRD-Port-Forwarding.md Phase 5 — external port differs from internal port', () => {
  it('the redirected port need not match the internal service port', async () => {
    const { outside, srv } = await buildLab('tcp');
    let accepted: TcpSocket | null = null;
    srv.getTcpStack().listen(INTERNAL_PORT, { onAccept: (s) => { accepted = s; } });

    outside.getTcpStack().connect(GW_OUTSIDE_IP, PUBLIC_PORT);

    expect(accepted).not.toBeNull();
    expect(PUBLIC_PORT).not.toBe(INTERNAL_PORT);
  });
});
