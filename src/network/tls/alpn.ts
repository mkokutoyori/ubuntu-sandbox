/**
 * RFC 7301 — Application-Layer Protocol Negotiation. The client offers an
 * ordered list of protocol names; the server picks, in its own preference
 * order, the first one the client also offered. No offer, or no overlap,
 * means no protocol is negotiated (RFC 7301 §3.2 lets the server either
 * proceed without ALPN or fail the connection — callers here choose which).
 */
export function selectAlpnProtocol(
  clientOffered: readonly string[] | undefined,
  serverSupported: readonly string[],
): string | null {
  if (!clientOffered || clientOffered.length === 0) return null;
  return serverSupported.find((protocol) => clientOffered.includes(protocol)) ?? null;
}
