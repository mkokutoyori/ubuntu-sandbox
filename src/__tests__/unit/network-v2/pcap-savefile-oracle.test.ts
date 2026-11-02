/**
 * The libpcap savefile codec against the real libpcap 1.10.4 (Ubuntu 24.04).
 *
 * scripts/oracle/record_pcap_savefile.py builds 44 savefiles (both byte orders, microsecond and nanosecond magics, the Kuznetsov record
 * header, the 2.0-2.3 length orders and 543.0, a snapshot shorter than the packets, three families of damage, a capture written by the real
 * tcpdump) and has the library open each one with nanosecond precision and read every packet: snapshot, version, byte order, link type,
 * each record's time stamp and lengths and bytes, and the library's own failure text. It also has the real pcap_dump write five
 * files. The codec must return the same reading for every file and the same bytes for every written file.
 *
 * Measured before the change: the codec did not exist (the savefile written by `tcpdump -w` was a JSON document of this repository), so
 * all 51 cases fall at the import and none passes either way. The WITNESS case reads the capture the real tcpdump wrote and must give six
 * records: it proves the harness and the codec see the same file the library saw, so a failure elsewhere accuses the codec and not the setup.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodePcap, encodePcap, linkTypeName, recordNanoseconds } from '@/network/capture/pcap/PcapFile';

interface Reading {
  openError?: string;
  name?: string | null;
  snapshot?: number;
  major?: number;
  minor?: number;
  swapped?: number;
  records?: ReadonlyArray<{ sec: number; nsec: number; caplen: number; len: number; data: string }>;
  readError?: string | null;
}

interface Written {
  name: string;
  nanosecond: boolean;
  linkType: number;
  snaplen: number;
  records: ReadonlyArray<{ seconds: number; subsecond: number; originalLength: number; data: string }>;
  hex: string;
}

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/pcap-savefile-1.10.4.json', import.meta.url), 'utf8')) as {
  cases: Array<{ name: string; hex: string; reading: Reading }>;
  written: Written[];
};

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

describe('savefile codec against the real libpcap: reading', () => {
  it('WITNESS: the capture written by the real tcpdump holds six records', () => {
    const real = fixture.cases.find((entry) => entry.name === 'real-tcpdump-ping')!;
    expect(real.reading.records).toHaveLength(6);
    const read = decodePcap(bytesOf(real.hex));
    expect(read.kind === 'file' && read.records.length).toBe(6);
  });

  for (const { name, hex, reading } of fixture.cases) {
    it(name, () => {
      const read = decodePcap(bytesOf(hex));
      if (reading.openError !== undefined) {
        expect(read).toEqual({ kind: 'unreadable', message: reading.openError });
        return;
      }
      if (read.kind !== 'file') throw new Error(read.message);
      expect(linkTypeName(read.header.linkType)).toBe(reading.name);
      expect(read.snapshot).toBe(reading.snapshot);
      expect(read.header.versionMajor).toBe(reading.major);
      expect(read.header.versionMinor).toBe(reading.minor);
      expect(read.header.bigEndian).toBe(reading.swapped === 1);
      expect(read.failure).toBe(reading.readError);
      expect(read.records.map((record) => ({
        sec: record.seconds,
        nsec: recordNanoseconds(read.header, record),
        caplen: record.capturedLength,
        len: record.originalLength,
        data: hexOf(record.data),
      }))).toEqual(reading.records);
    });
  }
});

describe('savefile codec against the real libpcap: writing', () => {
  for (const written of fixture.written) {
    it(written.name, () => {
      const bytes = encodePcap(
        { linkType: written.linkType, snaplen: written.snaplen, nanosecond: written.nanosecond },
        written.records.map((record) => ({
          seconds: record.seconds, subsecond: record.subsecond, originalLength: record.originalLength, data: bytesOf(record.data),
        })),
      );
      expect(hexOf(bytes)).toBe(written.hex);
    });
  }

  it('a capture read back is written back byte for byte', () => {
    const real = fixture.cases.find((entry) => entry.name === 'real-tcpdump-ping')!;
    const read = decodePcap(bytesOf(real.hex));
    if (read.kind !== 'file') throw new Error(read.message);
    const again = encodePcap(
      { linkType: read.header.linkType, snaplen: read.header.snaplen, nanosecond: read.header.nanosecond },
      read.records.map((record) => ({
        seconds: record.seconds, subsecond: record.subsecond, originalLength: record.originalLength, data: record.data,
      })),
    );
    expect(hexOf(again)).toBe(real.hex);
  });
});
