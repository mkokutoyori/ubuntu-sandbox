/**
 * PRD-TCP.md P6 — real TCP options (RFC 7323 window scaling/timestamps/PAWS,
 * RFC 2018 SACK), replacing the pre-P6 stack's total absence of an options
 * negotiation path (every option lived only as an inert `TcpOption[]` shape,
 * never populated or consulted).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { noFlags, computeTcpChecksum, type TcpSegment } from '@/network/tcp/types';
import type { IPv4Packet } from '@/network/core/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function buildPair() {
  const bus = new EventBus();
  const cli = new LinuxPC('CLI');
  const srv = new LinuxServer('linux-server', 'SRV');
  cli.setEventBus(bus); srv.setEventBus(bus);
  cli.powerOn(); srv.powerOn();
  const cable = new Cable('a');
  cable.setEventBus(bus);
  cable.connect(cli.getPort('eth0')!, srv.getPort('eth0')!);
  cli.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  // Pre-warm ARP both ways (a real link would already have these from a
  // prior exchange) so the lossy-cable scenarios below exercise TCP-level
  // segment loss/retransmission specifically, not the separate, single-shot,
  // non-retrying ARP-request-queue that `sendIpv4FrameArpAware` now goes
  // through on a cold cache (PRD audit #26) — that queue's own fixed 2s
  // timeout has nothing to do with TCP's RTO and would otherwise eat the
  // "lost exactly once" RNG slot these tests are built around.
  cli.addStaticARP(new IPAddress('10.0.0.2'), srv.getPort('eth0')!.getMAC(), 'eth0');
  srv.addStaticARP(new IPAddress('10.0.0.1'), cli.getPort('eth0')!.getMAC(), 'eth0');
  const scheduler = new VirtualTimeScheduler();
  cli.setScheduler(scheduler);
  srv.setScheduler(scheduler);
  return { cli, srv, bus, cable, scheduler };
}

describe('TCP options (PRD-TCP.md P6)', () => {
  it('negotiates MSS down to whichever side offers the smaller value', () => {
    const { cli, srv } = buildPair();
    let serverSocket: TcpSocket | null = null;
    srv.getTcpStack().listen(7400, { onAccept: (s) => { serverSocket = s; s.mss = 500; } });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7400)!;

    expect(serverSocket).not.toBeNull();
    expect(clientSocket.mss).toBe(500);
    expect(serverSocket!.mss).toBe(500);
  });

  it('negotiates a window-scale shift on both sides when both offer it (RFC 7323 §2.2)', () => {
    const { cli, srv } = buildPair();
    let serverSocket: TcpSocket | null = null;
    srv.getTcpStack().listen(7401, { onAccept: (s) => { serverSocket = s; } });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7401)!;

    expect(serverSocket).not.toBeNull();
    expect(clientSocket.peerWindowScale).toBe(serverSocket!.windowScale);
    expect(serverSocket!.peerWindowScale).toBe(clientSocket.windowScale);
  });

  it('SACK: receiver buffers out-of-order segments and delivers the full stream after just one retransmission fills the gap (no RTO wait)', () => {
    const { cli, srv, cable } = buildPair();
    const received: string[] = [];
    srv.getTcpStack().listen(7402, { onAccept: (s) => { s.onData((d) => received.push(d as string)); } });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7402)!;

    // Lose exactly the 2nd of 5 data segments in a 6000-byte/MSS-1460 burst
    // (see tcp-congestion-control.test.ts for how this call count was
    // empirically derived: call #3 is the 2nd client data segment).
    let calls = 0;
    cable.setPacketLossRate(0.999);
    cable.setRng(() => (++calls === 3 ? 0 : 1));

    clientSocket.send('D'.repeat(6000));

    // Fast retransmit (P5) resends the lost segment; because SACK is
    // negotiated, the receiver already buffered segments 3-5 out of order
    // and can flush its entire backlog with one cumulative ACK the moment
    // the gap is filled — no further RTO cycle needed.
    expect(received.join('')).toBe('D'.repeat(6000));
  });

  it('timestamps/RTTM: an ACK can sample RTT even off a retransmitted segment, bypassing Karn (RFC 7323 §4.3) — including the handshake SYN itself', () => {
    const { cli, srv, cable, scheduler } = buildPair();
    srv.getTcpStack().listen(7403, { onAccept: () => {} });

    // Lose only the very first SYN so the handshake completes via its
    // retransmission — the segment most likely to be starved of an RTT
    // sample, since `socket.timestampsEnabled` only flips true once the
    // SYN-ACK negotiating it has already been processed.
    let calls = 0;
    cable.setPacketLossRate(0.999);
    cable.setRng(() => (++calls === 1 ? 0 : 1));

    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7403)!;
    expect(clientSocket.rtt.hasMeasurement()).toBe(false);

    scheduler.advance(1010); // one RTO cycle retransmits the lost SYN

    expect(clientSocket.state).toBe('established');
    expect(clientSocket.rtt.hasMeasurement()).toBe(true);
  });

  it('PAWS: drops an out-of-order segment whose timestamp is older than the highest already seen (RFC 7323 §5)', () => {
    const { cli, srv } = buildPair();
    let serverSocket: TcpSocket | null = null;
    srv.getTcpStack().listen(7404, { onAccept: (s) => { serverSocket = s; } });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7404)!;
    expect(serverSocket).not.toBeNull();
    const sSocket = serverSocket!;
    expect(sSocket.timestampsEnabled).toBe(true);

    function inject(seq: number, tsVal: number, payload: string) {
      const seg: TcpSegment = {
        type: 'tcp', sourcePort: clientSocket.localPort, destinationPort: 7404,
        sequence: seq, acknowledgement: sSocket.sendNext,
        dataOffset: 5, flags: { ...noFlags(), ack: true },
        window: 65535, checksum: 0, urgentPointer: 0,
        options: [{ kind: 'timestamp', tsVal, tsEcr: sSocket.peerLastTsVal ?? 0 }],
        payload,
      };
      seg.checksum = computeTcpChecksum(seg, '10.0.0.1', '10.0.0.2');
      const pkt: IPv4Packet = {
        type: 'ipv4', version: 4, ihl: 5, tos: 0,
        totalLength: 40 + payload.length, identification: 1, flags: 0, fragmentOffset: 0,
        ttl: 64, protocol: 6, headerChecksum: 0,
        sourceIP: new IPAddress('10.0.0.1'), destinationIP: new IPAddress('10.0.0.2'),
        payload: seg,
      };
      srv.getTcpStack().handleIp('eth0', new IPAddress('10.0.0.1'), pkt);
    }

    // Genuinely out-of-order with a fresh timestamp — buffered normally.
    inject(sSocket.recvNext + 10, 999_999, 'FRESH');
    expect(sSocket.reassemblyBuffer.length).toBe(1);

    // Another out-of-order segment, but its timestamp predates the one
    // already recorded from this peer — PAWS must drop it, not buffer it.
    inject(sSocket.recvNext + 20, 1, 'STALE');
    expect(sSocket.reassemblyBuffer.length).toBe(1);
  });
});
