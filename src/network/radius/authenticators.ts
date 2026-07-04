/**
 * RADIUS integrity — Request/Response Authenticator (RFC 2865 §3) and
 * Message-Authenticator (RFC 2869 §5.14). Pure functions over
 * `RadiusPacket`/the wire codec: no transport side effects, no attribute
 * semantics beyond what integrity requires.
 */
import { md5, MD5 } from '@/crypto/hash';
import { hmac } from '@/crypto/mac';
import { bytesToHex, utf8ToBytes } from '@/crypto/encoding';
import { encodeRadiusPacket } from './codec';
import { attr, getAttr, type RadiusPacket } from './types';

const ZERO_MESSAGE_AUTHENTICATOR = '00'.repeat(16);

/**
 * `byteLength` random bytes as a hex string. Simulator-grade randomness —
 * same class of unpredictability as the project's other transaction
 * identifiers (DHCP XID, TCP ISN), not a CSPRNG guarantee.
 */
export function randomOpaqueToken(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytesToHex(bytes);
}

/**
 * A fresh, unpredictable 16-byte Request Authenticator for a new
 * Access-Request (RFC 2865 §3: "should be unpredictable").
 */
export function randomRequestAuthenticator(): string {
  return randomOpaqueToken(16);
}

/**
 * RFC 2865 §3 Response Authenticator:
 *   MD5(Code + Identifier + Length + RequestAuthenticator + Attributes + Secret)
 * — computed over the response's own Code/Identifier/Length/Attributes, but
 * with the *request's* authenticator substituted in for the computation.
 * Call this only after any Message-Authenticator attribute has already been
 * finalized (RFC 2869 §5.14 requires Message-Authenticator to be computed
 * first, then folded into the packet whose Response Authenticator is taken).
 */
export function computeResponseAuthenticator(
  response: RadiusPacket, requestAuthenticatorHex: string, secret: string,
): string {
  const forComputation: RadiusPacket = { ...response, authenticator: requestAuthenticatorHex };
  const wire = encodeRadiusPacket(forComputation);
  const secretBytes = utf8ToBytes(secret);
  const buf = new Uint8Array(wire.length + secretBytes.length);
  buf.set(wire, 0);
  buf.set(secretBytes, wire.length);
  return bytesToHex(md5(buf));
}

/** Return `response` with its `authenticator` field set to the conformant Response Authenticator. */
export function withResponseAuthenticator(
  response: RadiusPacket, requestAuthenticatorHex: string, secret: string,
): RadiusPacket {
  return { ...response, authenticator: computeResponseAuthenticator(response, requestAuthenticatorHex, secret) };
}

/** Verify a received response's Response Authenticator against the request that triggered it. */
export function verifyResponseAuthenticator(
  response: RadiusPacket, requestAuthenticatorHex: string, secret: string,
): boolean {
  const expected = computeResponseAuthenticator(response, requestAuthenticatorHex, secret);
  return constantTimeEqualHex(expected, response.authenticator);
}

/**
 * RFC 2869 §5.14 Message-Authenticator: HMAC-MD5(secret, packet) computed
 * with the Message-Authenticator attribute's value zeroed out and, for a
 * request, the packet's own (Request) authenticator; for a response, the
 * *originating request's* authenticator substituted for the response's own
 * (mirrors how the Response Authenticator itself is computed).
 */
export function computeMessageAuthenticator(
  packet: RadiusPacket, authenticatorForComputation: string, secret: string,
): string {
  const hasAttr = packet.attributes.some((a) => a.type === 'message-authenticator');
  const attributes = hasAttr
    ? packet.attributes.map((a) => (a.type === 'message-authenticator'
        ? { ...a, value: ZERO_MESSAGE_AUTHENTICATOR } : a))
    : [...packet.attributes, attr('message-authenticator', ZERO_MESSAGE_AUTHENTICATOR)];
  const forComputation: RadiusPacket = {
    ...packet, authenticator: authenticatorForComputation, attributes,
  };
  const wire = encodeRadiusPacket(forComputation);
  return bytesToHex(hmac(MD5, utf8ToBytes(secret), wire));
}

/** Return `packet` with a (added or replaced) conformant Message-Authenticator attribute. */
export function withMessageAuthenticator(
  packet: RadiusPacket, authenticatorForComputation: string, secret: string,
): RadiusPacket {
  const mac = computeMessageAuthenticator(packet, authenticatorForComputation, secret);
  const hasAttr = packet.attributes.some((a) => a.type === 'message-authenticator');
  const attributes = hasAttr
    ? packet.attributes.map((a) => (a.type === 'message-authenticator' ? { ...a, value: mac } : a))
    : [...packet.attributes, attr('message-authenticator', mac)];
  return { ...packet, attributes };
}

/**
 * Verify a packet's Message-Authenticator, if present. Returns `true` when
 * the attribute is absent — RFC 3579 §3.2 only mandates it for packets
 * carrying EAP; callers that require its presence (e.g. an EAP exchange)
 * must check `getAttr(packet, 'message-authenticator')` themselves.
 */
export function verifyMessageAuthenticator(
  packet: RadiusPacket, authenticatorForComputation: string, secret: string,
): boolean {
  const existing = getAttr(packet, 'message-authenticator');
  if (!existing) return true;
  const expected = computeMessageAuthenticator(packet, authenticatorForComputation, secret);
  return constantTimeEqualHex(expected, String(existing.value));
}

/** Case-insensitive, length-checked, non-short-circuiting hex comparison. */
function constantTimeEqualHex(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
