/**
 * FTP ALG through NAT (PRD-FTP-SFTP.md §2.1.10). Exercises
 * `inspectAndRewriteFtpAlg()` directly against hand-built `IPv4Packet`s,
 * mirroring `nat-pat.test.ts`'s own Group 1 pure-engine style — NATEngine
 * is tested at the packet level project-wide, not by routing a live TCP
 * session through a multi-hop `Router` topology (that combination isn't
 * exercised anywhere else in this repo's test suite either; confirmed by
 * reverting this phase's Router.ts/NATEngine.ts changes and observing an
 * identical stuck 'syn-sent' on a bare `TcpStack.connect()` across a
 * NAT'd router, with no FTP or ALG code involved at all — a pre-existing
 * simulator gap, not something this phase introduced or can fix).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPAddress, createIPv4Packet, IP_PROTO_TCP, resetCounters,
} from '@/network/core/types';
import type { TCPPacket, IPv4Packet } from '@/network/core/types';
import { NATEngine } from '@/network/devices/router/NATEngine';
import { inspectAndRewriteFtpAlg } from '@/network/devices/router/nat/FtpAlg';
import { encodeCommand, encodeReply, reply } from '@/network/ftp/replies';
import { encodePortArgument } from '@/network/ftp/DataChannel';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

function makeTcpPacket(srcIP: string, dstIP: string, srcPort: number, dstPort: number, text: string): IPv4Packet {
  const tcp: TCPPacket = {
    type: 'tcp', sourcePort: srcPort, destinationPort: dstPort,
    sequenceNumber: 1000, acknowledgementNumber: 0,
    flags: { syn: false, ack: true, fin: false, rst: false, psh: true, urg: false },
    windowSize: 65535, checksum: 0, payload: text,
  };
  return createIPv4Packet(new IPAddress(srcIP), new IPAddress(dstIP), IP_PROTO_TCP, 64, tcp, 40 + text.length);
}

describe('inspectAndRewriteFtpAlg — pure packet-level rewriting', () => {
  it('rewrites a PORT command payload and opens a matching pinhole', () => {
    const engine = new NATEngine();
    const portCmd = encodeCommand({ verb: 'PORT', argument: encodePortArgument('10.0.1.2', 40000) });
    const pkt = makeTcpPacket('10.0.1.2', '203.0.113.50', 21000, 21, portCmd);

    const rewritten = inspectAndRewriteFtpAlg(pkt, engine, '198.51.100.1');
    const tcp = rewritten.payload as TCPPacket;
    expect(tcp.payload).toContain('198,51,100,1');
    expect(tcp.payload).not.toContain('10,0,1,2');

    // The pinhole is now visible to translateInbound(): a SYN from the
    // server to the announced outside port gets forwarded to the client.
    const match = /(\d+,\d+,\d+,\d+,\d+,\d+)/.exec(tcp.payload as string);
    expect(match).not.toBeNull();
    const parts = match![1].split(',').map(Number);
    const globalPort = (parts[4] << 8) | parts[5];

    const inboundSyn = makeTcpPacket('203.0.113.50', '198.51.100.1', 21, globalPort, '');
    engine.setOutsideInterface('outside');
    const forwarded = engine.translateInbound(inboundSyn, 'outside');
    expect(forwarded).not.toBeNull();
    expect(forwarded!.destinationIP.toString()).toBe('10.0.1.2');
    expect((forwarded!.payload as TCPPacket).destinationPort).toBe(40000);
  });

  it('rewrites a PASV 227 reply payload and opens a matching pinhole', () => {
    const engine = new NATEngine();
    const pasvReply = encodeReply(reply(227, 'Entering Passive Mode (10,0,2,10,117,80).')); // port 30000
    const pkt = makeTcpPacket('10.0.2.10', '203.0.113.60', 21, 30500, pasvReply);

    const rewritten = inspectAndRewriteFtpAlg(pkt, engine, '198.51.100.1');
    const tcp = rewritten.payload as TCPPacket;
    expect(tcp.payload).toContain('198,51,100,1');
    expect(tcp.payload).not.toContain('10,0,2,10');
  });

  it('leaves non-FTP traffic untouched', () => {
    const engine = new NATEngine();
    const pkt = makeTcpPacket('10.0.1.2', '203.0.113.50', 443, 21999, 'not ftp at all');
    const result = inspectAndRewriteFtpAlg(pkt, engine, '198.51.100.1');
    expect(result).toBe(pkt);
  });

  it('leaves FTP control traffic without a PORT/227 payload untouched', () => {
    const engine = new NATEngine();
    const pkt = makeTcpPacket('10.0.1.2', '203.0.113.50', 21000, 21, encodeCommand({ verb: 'PWD' }));
    const result = inspectAndRewriteFtpAlg(pkt, engine, '198.51.100.1');
    expect(result).toBe(pkt);
  });

  it('does nothing once the ftp ALG is disabled', () => {
    const engine = new NATEngine();
    engine.setAlgEnabled('ftp', false);
    const portCmd = encodeCommand({ verb: 'PORT', argument: '10,0,1,2,156,32' });
    const pkt = makeTcpPacket('10.0.1.2', '203.0.113.50', 21000, 21, portCmd);
    const result = inspectAndRewriteFtpAlg(pkt, engine, '198.51.100.1');
    expect(result).toBe(pkt);
  });

  it('ftp ALG is enabled by default', () => {
    const engine = new NATEngine();
    expect(engine.isAlgEnabled('ftp')).toBe(true);
  });
});

describe('CLI toggles actually drive NATEngine (no longer inert)', () => {
  it('Huawei "nat alg ftp disable"/"nat alg ftp enable" toggle the engine', async () => {
    const r = new HuaweiRouter('HW1');
    await r.executeCommand('system-view');
    expect(r._getNATEngine().isAlgEnabled('ftp')).toBe(true);
    await r.executeCommand('nat alg ftp disable');
    expect(r._getNATEngine().isAlgEnabled('ftp')).toBe(false);
    await r.executeCommand('nat alg ftp enable');
    expect(r._getNATEngine().isAlgEnabled('ftp')).toBe(true);
  });

  it('Huawei "undo nat alg ftp" disables it', async () => {
    const r = new HuaweiRouter('HW1');
    await r.executeCommand('system-view');
    await r.executeCommand('undo nat alg ftp');
    expect(r._getNATEngine().isAlgEnabled('ftp')).toBe(false);
  });

  it('Cisco "ip nat service ftp"/"no ip nat service ftp" toggle the engine', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(r._getNATEngine().isAlgEnabled('ftp')).toBe(true);
    await r.executeCommand('no ip nat service ftp');
    expect(r._getNATEngine().isAlgEnabled('ftp')).toBe(false);
    await r.executeCommand('ip nat service ftp');
    expect(r._getNATEngine().isAlgEnabled('ftp')).toBe(true);
  });
});
