/**
 * PRD-QUIC.md §5 P10 — retry token and 3x amplification limit (RFC 9000
 * §8). Pure, standalone module — no network, no dependency on
 * QuicConnection.ts in this phase.
 */
import { describe, it, expect } from 'vitest';
import { generateRetryToken, verifyRetryToken, AmplificationLimiter } from '@/network/quic/retry';

describe('generateRetryToken / verifyRetryToken (RFC 9000 §8.1)', () => {
  it('verifies successfully for the same client address shortly after issuance', () => {
    const token = generateRetryToken('192.0.2.1', 5000, 'server-secret', 1000);
    expect(verifyRetryToken(token, '192.0.2.1', 5000, 'server-secret', 1500)).toBe(true);
  });

  it('rejects a token presented by a different client IP', () => {
    const token = generateRetryToken('192.0.2.1', 5000, 'server-secret', 1000);
    expect(verifyRetryToken(token, '192.0.2.2', 5000, 'server-secret', 1500)).toBe(false);
  });

  it('rejects a token presented from a different client port', () => {
    const token = generateRetryToken('192.0.2.1', 5000, 'server-secret', 1000);
    expect(verifyRetryToken(token, '192.0.2.1', 5001, 'server-secret', 1500)).toBe(false);
  });

  it('rejects an expired token', () => {
    const token = generateRetryToken('192.0.2.1', 5000, 'server-secret', 1000);
    expect(verifyRetryToken(token, '192.0.2.1', 5000, 'server-secret', 1000 + 10_001, 10_000)).toBe(false);
  });

  it('accepts a token right at the expiry boundary', () => {
    const token = generateRetryToken('192.0.2.1', 5000, 'server-secret', 1000);
    expect(verifyRetryToken(token, '192.0.2.1', 5000, 'server-secret', 1000 + 10_000, 10_000)).toBe(true);
  });

  it('rejects a tampered token (wrong digest)', () => {
    const token = generateRetryToken('192.0.2.1', 5000, 'server-secret', 1000);
    const tampered = token.replace(/\|[0-9a-f]+$/, '|deadbeef');
    expect(verifyRetryToken(tampered, '192.0.2.1', 5000, 'server-secret', 1500)).toBe(false);
  });

  it('rejects a token verified against the wrong server secret', () => {
    const token = generateRetryToken('192.0.2.1', 5000, 'server-secret', 1000);
    expect(verifyRetryToken(token, '192.0.2.1', 5000, 'other-secret', 1500)).toBe(false);
  });

  it('rejects a malformed token', () => {
    expect(verifyRetryToken('not-a-valid-token', '192.0.2.1', 5000, 'server-secret', 1500)).toBe(false);
  });
});

describe('AmplificationLimiter (RFC 9000 §8.1, 3x limit)', () => {
  it('allows sending up to 3x the bytes received before validation', () => {
    const limiter = new AmplificationLimiter();
    limiter.onBytesReceived(100);
    expect(limiter.canSend(300)).toBe(true);
    expect(limiter.canSend(301)).toBe(false);
  });

  it('accounts for bytes already sent against the 3x budget', () => {
    const limiter = new AmplificationLimiter();
    limiter.onBytesReceived(100);
    limiter.onBytesSent(250);
    expect(limiter.canSend(50)).toBe(true);
    expect(limiter.canSend(51)).toBe(false);
  });

  it('lifts the limit entirely once the address is validated', () => {
    const limiter = new AmplificationLimiter();
    limiter.onBytesReceived(10);
    expect(limiter.canSend(1_000_000)).toBe(false);
    limiter.onAddressValidated();
    expect(limiter.canSend(1_000_000)).toBe(true);
    expect(limiter.isAddressValidated).toBe(true);
  });

  it('stops counting received bytes toward the budget once validated', () => {
    const limiter = new AmplificationLimiter();
    limiter.onBytesReceived(100);
    limiter.onAddressValidated();
    limiter.onBytesReceived(1_000_000); // should be ignored now
    expect(limiter.canSend(999_999_999)).toBe(true); // unrestricted regardless
  });
});
