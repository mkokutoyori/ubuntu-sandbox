/**
 * FTP ALG (Application Layer Gateway) through NAT — PRD-FTP-SFTP.md
 * §2.1.10. RFC 959's `PORT`/`PASV` embed an IPv4 address/port in the
 * plaintext application payload, which NATEngine's IP/TCP header
 * rewriting alone can't fix: a client behind NAT announcing its own
 * inside address via `PORT` (or a server behind NAT announcing its own
 * inside address in a `PASV`/`EPSV` `227`/`229` reply) would tell the
 * peer to dial an address it can't actually reach. This module rewrites
 * that embedded address/port to the NAT'd outside address whenever an
 * outbound FTP control-channel packet carries one, and opens a matching
 * dynamic pinhole (`NATEngine.openAlgPinhole()`) for the announced port
 * so the data-channel connection that follows gets forwarded back to the
 * real inside endpoint — exactly what `nat alg ftp enable` (Huawei) /
 * `ip nat service ftp` (Cisco) do on a real router.
 */
import type { TcpSegment } from '../../../tcp/types';
import type { IPv4Packet, } from '@/network/core/types';
import { IP_PROTO_TCP, computeIPv4Checksum } from '@/network/core/types';
import {
  decodePortArgument, encodePortArgument, parseEprtArgument, encodeEprtArgument, decodeEpsvReplyArgument,
} from '@/network/ftp/DataChannel';
import { recomputeL4Checksum } from '@/network/nat/rewrite';
import type { NATEngine } from '../NATEngine';

const FTP_CONTROL_PORT = 21;
const ALG_PORT_MIN = 40000;
const ALG_PORT_MAX = 40999;
let nextAlgPort = ALG_PORT_MIN;

function allocateAlgPort(): number {
  const port = nextAlgPort;
  nextAlgPort = nextAlgPort >= ALG_PORT_MAX ? ALG_PORT_MIN : nextAlgPort + 1;
  return port;
}

const PORT_COMMAND_RE = /^PORT ([\d,]+)\r\n/i;
const EPRT_COMMAND_RE = /^EPRT (\S+)\r\n/i;
const PASV_REPLY_RE = /^227 [^(]*\(([\d,]+)\)/i;
const EPSV_REPLY_RE = /^229 [^(]*(\([^)]*\))/i;

function withPayload(pkt: IPv4Packet, tcp: TcpSegment, text: string): IPv4Packet {
  const delta = text.length - (tcp.payload as string).length;
  const result: IPv4Packet = {
    ...pkt, totalLength: pkt.totalLength + delta, headerChecksum: 0, payload: { ...tcp, payload: text },
  };
  recomputeL4Checksum(result);
  result.headerChecksum = computeIPv4Checksum(result);
  return result;
}

export function inspectAndRewriteFtpAlg(pkt: IPv4Packet, natEngine: NATEngine, announcedIP: string): IPv4Packet {
  if (!natEngine.isAlgEnabled('ftp')) return pkt;
  if (pkt.protocol !== IP_PROTO_TCP) return pkt;
  const tcp = pkt.payload as TcpSegment;
  if (!tcp || tcp.type !== 'tcp') return pkt;
  if (tcp.sourcePort !== FTP_CONTROL_PORT && tcp.destinationPort !== FTP_CONTROL_PORT) return pkt;
  if (typeof tcp.payload !== 'string') return pkt;

  const text = tcp.payload;
  const peer = pkt.destinationIP.toString();

  const openFor = (insideIP: string, insidePort: number, globalPort: number): void => {
    natEngine.openAlgPinhole({
      protocol: IP_PROTO_TCP,
      insideIP, insidePort,
      globalIP: announcedIP, globalPort,
      outsideIP: peer, outsidePort: 0,
      expectFromPeerOnly: true,
    });
  };


  const rewriteLine = (line: string): string => {
    const portMatch = PORT_COMMAND_RE.exec(line);
    if (portMatch) {
      const parsed = decodePortArgument(portMatch[1]);
      if (!parsed) return line;
      const globalPort = allocateAlgPort();
      openFor(parsed.address, parsed.port, globalPort);
      return line.replace(portMatch[1], encodePortArgument(announcedIP, globalPort));
    }
    const eprtMatch = EPRT_COMMAND_RE.exec(line);
    if (eprtMatch) {
      const parsed = parseEprtArgument(eprtMatch[1]);
      if (parsed.kind !== 'ok' || parsed.protocol !== 1) return line;
      const globalPort = allocateAlgPort();
      openFor(parsed.address, parsed.port, globalPort);
      return line.replace(eprtMatch[1], encodeEprtArgument(1, announcedIP, globalPort));
    }
    const pasvMatch = PASV_REPLY_RE.exec(line);
    if (pasvMatch) {
      const parsed = decodePortArgument(pasvMatch[1]);
      if (!parsed) return line;
      const globalPort = allocateAlgPort();
      openFor(parsed.address, parsed.port, globalPort);
      return line.replace(pasvMatch[1], encodePortArgument(announcedIP, globalPort));
    }
    const epsvMatch = EPSV_REPLY_RE.exec(line);
    if (epsvMatch) {
      const port = decodeEpsvReplyArgument(epsvMatch[1]);
      const inside = natEngine.insideLocalOf(pkt);
      if (port !== null && inside !== null) openFor(inside, port, port);
    }
    return line;
  };

  const rewrittenText = text.split(/(?<=\r\n)/).map(rewriteLine).join('');
  if (rewrittenText === text) return pkt;
  const out = withPayload(pkt, tcp, rewrittenText);
  natEngine.noteAlgRewrite(pkt, text.length, rewrittenText.length);
  return out;
}
