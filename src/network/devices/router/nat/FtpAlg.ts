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
import type { IPv4Packet, TCPPacket } from '@/network/core/types';
import { IP_PROTO_TCP } from '@/network/core/types';
import { decodePortArgument, encodePortArgument } from '@/network/ftp/DataChannel';
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

/** Matches a `PORT h1,h2,h3,h4,p1,p2` command line (CRLF-terminated, per replies.ts's codec). */
const PORT_COMMAND_RE = /^PORT ([\d,]+)\r\n/i;
/** Matches a `227 ...(h1,h2,h3,h4,p1,p2)...` PASV reply's first line (the only line for a single-line reply). */
const PASV_REPLY_RE = /^227 [^(]*\(([\d,]+)\)/i;

/**
 * Inspects one outbound TCP packet already NAT-translated by
 * `NATEngine.translateOutbound()`; if it's an FTP control-channel packet
 * carrying `PORT`/`227`, rewrites the embedded address/port to
 * `outsideIP`/a freshly allocated port and opens the matching pinhole.
 * Returns `pkt` unchanged if there's nothing to rewrite.
 */
export function inspectAndRewriteFtpAlg(pkt: IPv4Packet, natEngine: NATEngine, outsideIP: string): IPv4Packet {
  if (!natEngine.isAlgEnabled('ftp')) return pkt;
  if (pkt.protocol !== IP_PROTO_TCP) return pkt;
  const tcp = pkt.payload as TCPPacket;
  if (!tcp || tcp.type !== 'tcp') return pkt;
  if (tcp.sourcePort !== FTP_CONTROL_PORT && tcp.destinationPort !== FTP_CONTROL_PORT) return pkt;
  if (typeof tcp.payload !== 'string') return pkt;

  const text = tcp.payload;
  const portMatch = PORT_COMMAND_RE.exec(text);
  const pasvMatch = !portMatch ? PASV_REPLY_RE.exec(text) : null;
  const rawArg = portMatch?.[1] ?? pasvMatch?.[1];
  if (!rawArg) return pkt;

  const parsed = decodePortArgument(rawArg);
  if (!parsed) return pkt;

  const globalPort = allocateAlgPort();
  natEngine.openAlgPinhole({
    protocol: IP_PROTO_TCP,
    insideIP: parsed.address, insidePort: parsed.port,
    globalIP: outsideIP, globalPort,
    outsideIP: pkt.destinationIP.toString(), outsidePort: tcp.destinationPort,
  });

  const rewrittenArg = encodePortArgument(outsideIP, globalPort);
  const rewrittenText = text.replace(rawArg, rewrittenArg);
  return { ...pkt, payload: { ...tcp, payload: rewrittenText } };
}
