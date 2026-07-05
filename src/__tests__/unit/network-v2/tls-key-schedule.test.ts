import { describe, it, expect } from 'vitest';
import {
  deriveKeySchedule, extractSecret, expandLabel, transcriptHash, ZERO_IKM,
  type KeyScheduleTranscripts,
} from '@/network/tls/keySchedule';
import { utf8ToBytes } from '@/crypto/encoding';

function transcripts(seed: string): KeyScheduleTranscripts {
  return {
    clientHello: `ch-${seed}`,
    serverHello: `sh-${seed}`,
    serverFinished: `sf-${seed}`,
    clientFinished: `cf-${seed}`,
  };
}

describe('extractSecret / expandLabel — primitives', () => {
  it('is deterministic for identical inputs', () => {
    expect(extractSecret('salt', 'ikm')).toBe(extractSecret('salt', 'ikm'));
    expect(expandLabel('secret', 'label', 'ctx')).toBe(expandLabel('secret', 'label', 'ctx'));
  });

  it('diverges when salt, ikm, label, or context differ', () => {
    const base = extractSecret('salt', 'ikm');
    expect(extractSecret('other-salt', 'ikm')).not.toBe(base);
    expect(extractSecret('salt', 'other-ikm')).not.toBe(base);

    const baseLabel = expandLabel('secret', 'c hs traffic', 'ctx');
    expect(expandLabel('secret', 's hs traffic', 'ctx')).not.toBe(baseLabel);
    expect(expandLabel('secret', 'c hs traffic', 'other-ctx')).not.toBe(baseLabel);
    expect(expandLabel('other-secret', 'c hs traffic', 'ctx')).not.toBe(baseLabel);
  });
});

describe('transcriptHash', () => {
  it('is sensitive to both content and order of messages', () => {
    const a = utf8ToBytes('a');
    const b = utf8ToBytes('b');
    expect(transcriptHash([a, b])).not.toBe(transcriptHash([b, a]));
    expect(transcriptHash([a])).not.toBe(transcriptHash([b]));
    expect(transcriptHash([a, b])).toBe(transcriptHash([a, b]));
  });
});

describe('deriveKeySchedule — RFC 8446 §7.1 tree', () => {
  it('is fully deterministic given identical transcripts and PSK/DHE input', () => {
    const t = transcripts('x');
    const s1 = deriveKeySchedule(t, ZERO_IKM, ZERO_IKM);
    const s2 = deriveKeySchedule(t, ZERO_IKM, ZERO_IKM);
    expect(s1).toEqual(s2);
  });

  it('diverges completely when the transcript differs', () => {
    const s1 = deriveKeySchedule(transcripts('x'));
    const s2 = deriveKeySchedule(transcripts('y'));
    expect(s1.clientHandshakeTrafficSecret).not.toBe(s2.clientHandshakeTrafficSecret);
    expect(s1.serverHandshakeTrafficSecret).not.toBe(s2.serverHandshakeTrafficSecret);
    expect(s1.clientApplicationTrafficSecret).not.toBe(s2.clientApplicationTrafficSecret);
    expect(s1.serverApplicationTrafficSecret).not.toBe(s2.serverApplicationTrafficSecret);
  });

  it('diverges when the (EC)DHE shared secret differs, even with the same transcript', () => {
    const t = transcripts('x');
    const s1 = deriveKeySchedule(t, ZERO_IKM, 'dhe-shared-1');
    const s2 = deriveKeySchedule(t, ZERO_IKM, 'dhe-shared-2');
    expect(s1.handshakeSecret).not.toBe(s2.handshakeSecret);
    expect(s1.masterSecret).not.toBe(s2.masterSecret);
  });

  it('diverges when the PSK differs, even with the same transcript and DHE secret', () => {
    const t = transcripts('x');
    const s1 = deriveKeySchedule(t, 'psk-1');
    const s2 = deriveKeySchedule(t, 'psk-2');
    expect(s1.earlySecret).not.toBe(s2.earlySecret);
    expect(s1.binderKey).not.toBe(s2.binderKey);
  });

  it('keeps the handshake traffic secrets distinct from the application traffic secrets', () => {
    const s = deriveKeySchedule(transcripts('x'));
    const all = [
      s.earlySecret, s.binderKey, s.clientEarlyTrafficSecret, s.earlyExporterMasterSecret,
      s.handshakeSecret, s.clientHandshakeTrafficSecret, s.serverHandshakeTrafficSecret,
      s.masterSecret, s.clientApplicationTrafficSecret, s.serverApplicationTrafficSecret,
      s.exporterMasterSecret, s.resumptionMasterSecret,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps client and server traffic secrets distinct in both the handshake and application phases', () => {
    const s = deriveKeySchedule(transcripts('x'));
    expect(s.clientHandshakeTrafficSecret).not.toBe(s.serverHandshakeTrafficSecret);
    expect(s.clientApplicationTrafficSecret).not.toBe(s.serverApplicationTrafficSecret);
  });

  it('separates the early, handshake, and master secret stages', () => {
    const s = deriveKeySchedule(transcripts('x'));
    expect(s.earlySecret).not.toBe(s.handshakeSecret);
    expect(s.handshakeSecret).not.toBe(s.masterSecret);
    expect(s.earlySecret).not.toBe(s.masterSecret);
  });

  it('derives the resumption master secret from the client Finished transcript, distinct from application traffic secrets bound to the server Finished transcript', () => {
    const s = deriveKeySchedule(transcripts('x'));
    expect(s.resumptionMasterSecret).not.toBe(s.clientApplicationTrafficSecret);
    expect(s.resumptionMasterSecret).not.toBe(s.exporterMasterSecret);
  });
});
