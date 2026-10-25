/**
 * Probe - the byte formats of src/network/rsyslog/engine/segdisk/, ported from runtime/segdisk_crc.c (CRC32C), segdisk_state.c
 * (the two 256-byte state slots, RSSEGST2) and segdisk_codec.c (the TLV record payload).
 *
 * Measured against the preceding commit (git stash push -- src/network): the file cannot be loaded, the five modules it
 * imports did not exist, so its 5 cases fall by construction. No witness: a format that did not exist has nothing to
 * keep. The behaviour built on these formats is measured in rsyslog-segmented-disk.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { crc32c } from '@/network/rsyslog/engine/segdisk/Crc32c';
import { decodeSlot, encodeSlot, selectSlot, validateSlot, type StateImage } from '@/network/rsyslog/engine/segdisk/StateSlot';
import { decodeImage, encodeImage } from '@/network/rsyslog/engine/segdisk/RecordCodec';
import { imageOf, messageOf } from '@/network/rsyslog/engine/MessageCodec';
import { RsyslogMessage } from '@/network/rsyslog/Message';

function sampleState(): StateImage {
  return {
    uuid: 'ABCDEFGHIJKLMNOP', generation: 0, flags: 0, committedSegment: 7, committedOffset: 407, committedRecordSequence: 3, firstLiveSegment: 7,
    lastDataSegment: 7, activeSegment: 8, recoveryFirst: 0, recoveryLast: 0, nextSegment: 9, knownQueueSize: 5, bytes: 1234, segments: 2,
    writerSegment: 8, writerEnd: 52, writerSequence: 0, writerCount: 0, deleteFirst: 0, deleteLast: 0, deleteBytes: 0, deleteSegments: 0,
  };
}

describe('formats', () => {
  it('crc32c is the Castagnoli checksum', () => {
    expect(crc32c('123456789')).toBe(0xe3069283);
    expect(crc32c('')).toBe(0);
  });

  it('a state slot round-trips and a flipped byte invalidates it', () => {
    const slot = encodeSlot(sampleState(), 3);
    expect(slot).toHaveLength(256);
    expect(slot.startsWith('RSSEGST2')).toBe(true);
    expect(validateSlot(slot)).toBe(true);
    expect(decodeSlot(slot)).toMatchObject({ generation: 3, committedSegment: 7, committedOffset: 407, knownQueueSize: 5, bytes: 1234, nextSegment: 9 });
    expect(validateSlot(slot.slice(0, 100) + 'x' + slot.slice(101))).toBe(false);
  });

  it('the newer valid generation wins and slots of different stores are refused', () => {
    const older = encodeSlot(sampleState(), 4);
    const newer = encodeSlot(sampleState(), 5);
    expect(selectSlot(older, newer)?.state.generation).toBe(5);
    expect(selectSlot(newer, older)?.slot).toBe(0);
    expect(selectSlot(older, newer.slice(0, 100) + 'x' + newer.slice(101))?.state.generation).toBe(4);
    expect(selectSlot(older, encodeSlot({ ...sampleState(), uuid: 'ZZZZZZZZZZZZZZZZ' }, 5))).toBeNull();
    expect(selectSlot('\0'.repeat(256), '\0'.repeat(256))).toBeNull();
  });

  it('a message survives the TLV record codec, accents and structured data included', () => {
    const message = new RsyslogMessage({
      rawMsg: '<165>1 2025-10-19T12:00:01+02:00 hôte app 12 ID47 [meta k="v"] déjà vu', receivedAt: { timeType: 2, year: 2025, month: 10, day: 19, hour: 10, minute: 0, second: 1, secfrac: 0, secfracPrecision: 0, offsetMode: '+', offsetHour: 2, offsetMinute: 0 },
      inputName: 'imuxsock', fromHost: 'hôte', fromHostIp: '10.0.0.7', fromHostPort: '514', internal: false, parseHostname: true, ignoreDate: false,
      noPriInRaw: false, defaultTimeZone: null, mark: false, localHostName: 'ubuntu',
    });
    message.parsePriFromRaw();
    const context = { localHostName: 'ubuntu', defaultTimeZone: null, compactJson: true };
    const image = decodeImage(encodeImage(imageOf(message, context)));
    expect(image).toMatchObject({ rawMsg: message.rawMsg, offset: imageOf(message, context).offset, fromHost: 'hôte', fromHostIp: '10.0.0.7', fromHostPort: '514', inputName: 'imuxsock' });
    expect(messageOf(image, context).msg).toBe(message.msg);
  });

  it('a truncated or duplicated field is refused', () => {
    const payload = encodeImage({
      protocolVersion: 0, severity: 5, facility: 1, flags: 0, generatedAt: 1, receivedAt: sampleTime(), timestamp: sampleTime(), tag: 't', rawMsg: 'hello', offset: 0,
      hostname: 'h', inputName: 'i', fromHost: '', fromHostIp: '', fromHostPort: '', structuredData: null, json: null, localVariables: null, appName: null,
      procId: null, msgId: null, ruleset: null,
    });
    expect(() => decodeImage(payload.slice(0, payload.length - 3))).toThrow();
    expect(() => decodeImage(payload + payload.slice(0, 9))).toThrow();
  });
});

function sampleTime() {
  return { timeType: 1 as const, year: 2025, month: 10, day: 19, hour: 12, minute: 0, second: 1, secfrac: 0, secfracPrecision: 0, offsetMode: '' as const, offsetHour: 0, offsetMinute: 0 };
}

