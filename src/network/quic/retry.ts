import { simulatedDigest } from '@/network/dns/dnssec/Digest';

// RFC 9000 §8.1 — a Retry token proves the client received a Retry packet
// sent to its claimed source address, without the server keeping
// per-client state. Simulated here as a deterministic, verifiable,
// expirable digest rather than real AEAD-sealed retry integrity (cf.
// PRD-QUIC.md §5 P10: "jeton de Retry simulé, déterministe, vérifiable").
function computeRetryDigest(clientIp: string, clientPort: number, issuedAt: number, serverSecret: string): string {
  return simulatedDigest(`${clientIp}:${clientPort}:${issuedAt}:${serverSecret}`);
}

export function generateRetryToken(clientIp: string, clientPort: number, serverSecret: string, now: number): string {
  const digest = computeRetryDigest(clientIp, clientPort, now, serverSecret);
  return `${clientIp}|${clientPort}|${now}|${digest}`;
}

export function verifyRetryToken(
  token: string, clientIp: string, clientPort: number, serverSecret: string, now: number, maxAgeMs = 10_000,
): boolean {
  const parts = token.split('|');
  if (parts.length !== 4) return false;
  const [ip, portStr, issuedAtStr, digest] = parts;
  if (ip !== clientIp) return false;
  if (parseInt(portStr, 10) !== clientPort) return false;

  const issuedAt = parseInt(issuedAtStr, 10);
  if (isNaN(issuedAt) || now < issuedAt || now - issuedAt > maxAgeMs) return false;

  return computeRetryDigest(clientIp, clientPort, issuedAt, serverSecret) === digest;
}

/**
 * RFC 9000 §8.1 — until a client's address is validated, a server MUST NOT
 * send more than 3x the bytes it has received from that address (bounding
 * the amplification available to an off-path attacker spoofing the
 * client's source address).
 */
export class AmplificationLimiter {
  private bytesReceived = 0;
  private bytesSent = 0;
  private validated = false;

  onBytesReceived(n: number): void {
    if (!this.validated) this.bytesReceived += n;
  }

  onAddressValidated(): void {
    this.validated = true;
  }

  get isAddressValidated(): boolean {
    return this.validated;
  }

  canSend(n: number): boolean {
    if (this.validated) return true;
    return this.bytesSent + n <= this.bytesReceived * 3;
  }

  onBytesSent(n: number): void {
    this.bytesSent += n;
  }
}
