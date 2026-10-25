/*
 * Probe - the protobuf the remote-write client packs (plugins/impstats/prometheus_remote_write.c with remote.proto, built by protobuf-c in proto3 mode): the
 * bytes are written out by hand from the wire format (tag = field << 3 | wire type, little-endian IEEE 754 for the double, base-128 varint for the
 * timestamp), a proto3 scalar equal to zero and an empty string are not emitted but the enclosing message still is, labels are sorted by strcmp on the bytes of
 * the name, and a pair without "=" is dropped.  A pair keeps what follows its first "=" as the value.
 * Measured before the encoder existed (git stash push -- src/network): the module is untracked-new, so all 7 cases fail at import.
 */
import { describe, expect, it } from 'vitest';
import { buildSeries, encodeWriteRequest, packWriteRequest } from '@/network/rsyslog/PrometheusRemoteWrite';
import { snappyUncompress } from '@/network/rsyslog/Snappy';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('prometheus remote write encoding', () => {
  it('packs one series by hand: __name__ label, then a sample of a double and a varint timestamp', () => {
    const expected = '0a1d' + '0a0d' + '0a085f5f6e616d655f5f' + '1201' + '61' + '120c' + '09' + '000000000000f83f' + '10' + 'e807';
    expect(hex(packWriteRequest([buildSeries('a', 1.5, 1000, [])]))).toBe(expected);
  });

  it('leaves out a zero value but keeps the timestamp, and keeps an empty sample message when both are zero', () => {
    expect(hex(packWriteRequest([buildSeries('a', 0, 1000, [])]))).toBe('0a14' + '0a0d' + '0a085f5f6e616d655f5f' + '1201' + '61' + '1203' + '10' + 'e807');
    expect(hex(packWriteRequest([buildSeries('a', 0, 0, [])]))).toBe('0a11' + '0a0d' + '0a085f5f6e616d655f5f' + '1201' + '61' + '1200');
  });

  it('emits a negative zero, whose bits are not zero, as protobuf-c compares them', () => {
    expect(hex(packWriteRequest([buildSeries('a', -0, 1, [])]))).toContain('090000000000000080');
  });

  it('writes an empty label value as a label message holding only the name', () => {
    const packed = hex(packWriteRequest([buildSeries('a', 1, 1, ['k='])]));
    expect(packed).toContain('0a03' + '0a01' + '6b' + '12');
    expect(packed).not.toContain('1200' + '1201');
  });

  it('sorts the labels by the bytes of their names, so an upper-case name precedes __name__', () => {
    const [series] = [buildSeries('m', 1, 1, ['b=2', 'Z=1', 'a=3'])];
    expect(series.labels.map((label) => Buffer.from(label.name).toString())).toEqual(['Z', '__name__', 'a', 'b']);
  });

  it('drops a pair without "=" and keeps the text after the first "=" as the value', () => {
    const series = buildSeries('m', 1, 1, ['plain', 'url=http://h/?a=b']);
    expect(series.labels.map((label) => Buffer.from(label.name).toString())).toEqual(['__name__', 'url']);
    expect(Buffer.from(series.labels[1].value).toString()).toBe('http://h/?a=b');
  });

  it('compresses the packed request with Snappy so that it decompresses to the packed bytes', () => {
    const series = [buildSeries('a', 3, 5, ['x=y']), buildSeries('b', 4, 5, [])];
    const result = snappyUncompress(encodeWriteRequest(series));
    expect(result.ok).toBe(true);
    if (result.ok) expect(hex(result.bytes)).toBe(hex(packWriteRequest(series)));
  });
});
