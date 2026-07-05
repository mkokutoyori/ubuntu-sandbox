import { describe, it, expect } from 'vitest';
import { utf8ToBytes, bytesToUtf8 } from '@/crypto/encoding';
import {
  encodeHandshakeMessage, decodeHandshakeMessage, randomNonce,
  type ClientHello, type ServerHello, type HelloRetryRequest, type EncryptedExtensionsMessage,
  type CertificateRequest, type CertificateMessage, type CertificateVerify, type Finished,
  type NewSessionTicket, type KeyUpdate,
} from '@/network/tls/messages';
import {
  fragmentPlaintext, reassembleFragments, encodeInnerPlaintext, decodeInnerPlaintext,
  fragmentAsRecords, reassembleRecords, type TlsRecord,
} from '@/network/tls/recordLayer';
import { HELLO_RETRY_REQUEST_RANDOM, MAX_TLS_RECORD_LENGTH, TLS_LEGACY_RECORD_VERSION } from '@/network/tls/types';
import type { X509Certificate } from '@/network/pki/X509Certificate';

function fakeCert(subject: string): X509Certificate {
  return {
    version: 3, serialNumber: '1', subject, issuer: 'CN=test-ca',
    notBefore: 0, notAfter: 1e12,
    publicKey: { algorithm: 'rsa', material: 'n' },
    signatureAlgorithm: 'sha256WithRSAEncryption',
    signature: 'sig',
  };
}

describe('TLS 1.3 handshake messages — encode/decode round-trip', () => {
  it('round-trips a ClientHello', () => {
    const msg: ClientHello = {
      kind: 'client_hello', legacyVersion: '1.2', random: randomNonce('cli'),
      cipherSuites: ['TLS_AES_128_GCM_SHA256', 'TLS_CHACHA20_POLY1305_SHA256'],
      extensions: {
        supportedVersions: ['1.3'], keyShare: 'x25519:abc', supportedGroups: ['x25519'],
        signatureAlgorithms: ['ecdsa_secp256r1_sha256'], serverName: 'example.test',
        alpn: ['h2', 'http/1.1'],
      },
    };
    const decoded = decodeHandshakeMessage(encodeHandshakeMessage(msg));
    expect(decoded).toEqual(msg);
  });

  it('round-trips a ServerHello', () => {
    const msg: ServerHello = {
      kind: 'server_hello', random: randomNonce('srv'), cipherSuite: 'TLS_AES_128_GCM_SHA256',
      extensions: { supportedVersions: '1.3', keyShare: 'x25519:def' },
    };
    expect(decodeHandshakeMessage(encodeHandshakeMessage(msg))).toEqual(msg);
  });

  it('round-trips a HelloRetryRequest with the RFC 8446 §4.1.3 magic random', () => {
    const msg: HelloRetryRequest = {
      kind: 'hello_retry_request', random: HELLO_RETRY_REQUEST_RANDOM, selectedGroup: 'secp256r1',
    };
    const decoded = decodeHandshakeMessage(encodeHandshakeMessage(msg)) as HelloRetryRequest;
    expect(decoded.random).toBe(HELLO_RETRY_REQUEST_RANDOM);
    expect(decoded).toEqual(msg);
  });

  it('round-trips EncryptedExtensions', () => {
    const msg: EncryptedExtensionsMessage = { kind: 'encrypted_extensions', extensions: { alpn: 'h2', earlyData: true } };
    expect(decodeHandshakeMessage(encodeHandshakeMessage(msg))).toEqual(msg);
  });

  it('round-trips a CertificateRequest', () => {
    const msg: CertificateRequest = {
      kind: 'certificate_request', certificateRequestContext: '', signatureAlgorithms: ['ecdsa_secp256r1_sha256'],
    };
    expect(decodeHandshakeMessage(encodeHandshakeMessage(msg))).toEqual(msg);
  });

  it('round-trips a Certificate carrying a real X509Certificate shape', () => {
    const msg: CertificateMessage = { kind: 'certificate', certificateList: [fakeCert('CN=server'), fakeCert('CN=intermediate')] };
    expect(decodeHandshakeMessage(encodeHandshakeMessage(msg))).toEqual(msg);
  });

  it('round-trips CertificateVerify', () => {
    const msg: CertificateVerify = { kind: 'certificate_verify', signature: 'sig-over-transcript' };
    expect(decodeHandshakeMessage(encodeHandshakeMessage(msg))).toEqual(msg);
  });

  it('round-trips Finished', () => {
    const msg: Finished = { kind: 'finished', verifyData: 'mac-over-transcript' };
    expect(decodeHandshakeMessage(encodeHandshakeMessage(msg))).toEqual(msg);
  });

  it('round-trips NewSessionTicket', () => {
    const msg: NewSessionTicket = {
      kind: 'new_session_ticket', ticketLifetime: 7200, ticketAgeAdd: 'add-1', ticketNonce: 'nonce-1',
      ticket: 'opaque-ticket', extensions: { earlyData: true },
    };
    expect(decodeHandshakeMessage(encodeHandshakeMessage(msg))).toEqual(msg);
  });

  it('round-trips KeyUpdate', () => {
    const msg: KeyUpdate = { kind: 'key_update', requestUpdate: true };
    expect(decodeHandshakeMessage(encodeHandshakeMessage(msg))).toEqual(msg);
  });
});

describe('randomNonce', () => {
  it('never repeats across calls', () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomNonce('n')));
    expect(seen.size).toBe(50);
  });
});

describe('record layer — fragmentation (RFC 8446 §5.1)', () => {
  it('keeps a small message in a single record', () => {
    const plaintext = utf8ToBytes('hello');
    const records = fragmentPlaintext('handshake', plaintext);
    expect(records).toHaveLength(1);
    expect(records[0].legacyVersion).toBe(TLS_LEGACY_RECORD_VERSION);
    expect(bytesToUtf8(records[0].fragment)).toBe('hello');
  });

  it('splits an oversized message into multiple records at a reduced fragment size, mirroring the EAP-TLS mtu:40 precedent', () => {
    const plaintext = utf8ToBytes('x'.repeat(97));
    const records = fragmentPlaintext('handshake', plaintext, 20);
    expect(records.length).toBeGreaterThan(4);
    for (const r of records.slice(0, -1)) expect(r.fragment.length).toBe(20);
    const { contentType, plaintext: reassembled } = reassembleFragments(records);
    expect(contentType).toBe('handshake');
    expect(bytesToUtf8(reassembled)).toBe('x'.repeat(97));
  });

  it('respects the RFC default ceiling of 2^14 bytes per fragment', () => {
    const plaintext = new Uint8Array(MAX_TLS_RECORD_LENGTH * 2 + 5);
    const records = fragmentPlaintext('application_data', plaintext);
    expect(records).toHaveLength(3);
    expect(records[0].fragment.length).toBe(MAX_TLS_RECORD_LENGTH);
    expect(records[1].fragment.length).toBe(MAX_TLS_RECORD_LENGTH);
    expect(records[2].fragment.length).toBe(5);
  });

  it('round-trips an empty plaintext as a single empty-fragment record', () => {
    const records = fragmentPlaintext('alert', new Uint8Array(0));
    expect(records).toHaveLength(1);
    expect(records[0].fragment.length).toBe(0);
    const { plaintext } = reassembleFragments(records);
    expect(plaintext.length).toBe(0);
  });

  it('rejects reassembly of records with mixed content types', () => {
    const records: TlsRecord[] = [
      { contentType: 'handshake', legacyVersion: TLS_LEGACY_RECORD_VERSION, fragment: utf8ToBytes('a') },
      { contentType: 'alert', legacyVersion: TLS_LEGACY_RECORD_VERSION, fragment: utf8ToBytes('b') },
    ];
    expect(() => reassembleFragments(records)).toThrow();
  });

  it('rejects reassembly of an empty record list', () => {
    expect(() => reassembleFragments([])).toThrow();
  });
});

describe('record layer — §5.4 record-type obfuscation', () => {
  it('carries the real content type in the clear before protection is active', () => {
    const records = fragmentAsRecords('handshake', utf8ToBytes('client hello bytes'), false);
    expect(records.every((r) => r.contentType === 'handshake')).toBe(true);
    const { contentType, plaintext } = reassembleRecords(records, false);
    expect(contentType).toBe('handshake');
    expect(bytesToUtf8(plaintext)).toBe('client hello bytes');
  });

  it('labels every outer record application_data once protection is active, hiding the real type inside', () => {
    const records = fragmentAsRecords('handshake', utf8ToBytes('encrypted extensions bytes'), true);
    expect(records.every((r) => r.contentType === 'application_data')).toBe(true);
    const { contentType, plaintext } = reassembleRecords(records, true);
    expect(contentType).toBe('handshake');
    expect(bytesToUtf8(plaintext)).toBe('encrypted extensions bytes');
  });

  it('obfuscates across multiple records when the protected payload is fragmented', () => {
    const original = 'y'.repeat(97);
    const records = fragmentAsRecords('application_data', utf8ToBytes(original), true, 20);
    expect(records.length).toBeGreaterThan(1);
    expect(records.every((r) => r.contentType === 'application_data')).toBe(true);
    const { contentType, plaintext } = reassembleRecords(records, true);
    expect(contentType).toBe('application_data');
    expect(bytesToUtf8(plaintext)).toBe(original);
  });

  it('rejects an unprotected reassembly of a record mislabeled application_data when protection was expected', () => {
    const records = fragmentPlaintext('handshake', utf8ToBytes('oops'));
    expect(() => reassembleRecords(records, true)).toThrow();
  });

  it('inner-plaintext encode/decode round-trips content and type independently of fragmentation', () => {
    const inner = encodeInnerPlaintext({ content: utf8ToBytes('hi'), contentType: 'alert' });
    const decoded = decodeInnerPlaintext(inner);
    expect(decoded.contentType).toBe('alert');
    expect(bytesToUtf8(decoded.content)).toBe('hi');
  });

  it('rejects decoding an empty inner-plaintext payload (no content-type trailer)', () => {
    expect(() => decodeInnerPlaintext(new Uint8Array(0))).toThrow();
  });
});
