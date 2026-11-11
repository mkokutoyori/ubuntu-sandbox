/**
 * Probe: a Linux machine's journal no longer holds its data hash table as
 * megabytes of zero bytes.
 *
 * Measured before the change (10 machines kept alive, forks pool,
 * --expose-gc): each LinuxPC and LinuxServer held 4.00 MB of ArrayBuffer on
 * top of 1.9 MB of heap. The owner is JournalImage: systemd sizes the data
 * hash table from SystemMaxFileSize, about 3.5 MB of 16-byte buckets, and the
 * image kept the whole file as one contiguous buffer. After the change the
 * buckets live in a sparse map (GappedBytes) and the same machine holds
 * 0.06 MB of ArrayBuffer.
 *
 * Discrimination (git stash push -- src/network): 1 of 5 cases falls on the
 * base, "five machines stay under one megabyte of buffers each".
 * Pass either way:
 *  - the three GappedBytes cases exercise a module that is new, so the base
 *    has nothing for them to contradict;
 *    they are structural, comparing every accessor against a plain buffer;
 *  - "the journal file read through the VFS keeps its allocated size" is the
 *    WITNESS: the lab writes a real journal and the file is still complete.
 */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network';
import { GappedBytes } from '@/network/devices/linux/journal/format/GappedBytes';

const MEGABYTE = 1024 * 1024;

function mirrored(gapStart: number, gapLength: number, capacity: number): { gapped: GappedBytes; plain: Uint8Array; view: DataView } {
  const gapped = new GappedBytes(64);
  gapped.ensure(gapStart);
  gapped.openGap(gapStart, gapLength);
  gapped.ensure(capacity);
  let size = 64;
  while (size < capacity) size *= 2;
  const plain = new Uint8Array(size);
  return { gapped, plain, view: new DataView(plain.buffer) };
}

describe('GappedBytes answers like a contiguous buffer', () => {
  it('reads back words written before, inside and after the gap', () => {
    const { gapped, plain, view } = mirrored(64, 4096, 8192);
    for (const offset of [0, 56, 64, 72, 2048, 4152, 4160, 4168, 8000]) {
      const value = 0x1234567 + offset * 977;
      gapped.setU64(offset, value);
      view.setUint32(offset, value % 0x100000000, true);
      view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
    }
    for (let offset = 0; offset + 8 <= 8192; offset += 8) {
      expect(gapped.u64(offset)).toBe(view.getUint32(offset + 4, true) * 0x100000000 + view.getUint32(offset, true));
      expect(gapped.bigU64(offset)).toBe(view.getBigUint64(offset, true));
    }
    expect(Array.from(gapped.slice(0, 8192))).toEqual(Array.from(plain.subarray(0, 8192)));
    expect(gapped.capacity).toBe(plain.length);
  });

  it('copies byte runs that straddle either edge of the gap', () => {
    const { gapped, plain } = mirrored(64, 256, 1024);
    const run = Uint8Array.from({ length: 40 }, (_, index) => index + 1);
    for (const offset of [50, 100, 300, 600]) {
      gapped.set(run, offset);
      plain.set(run, offset);
    }
    gapped.setU8(65, 0xab);
    plain[65] = 0xab;
    for (const [offset, length] of [[0, 1024], [40, 60], [60, 300], [310, 20], [500, 524], [1000, 400]] as const) {
      expect(Array.from(gapped.slice(offset, length))).toEqual(Array.from(plain.slice(offset, offset + length)));
    }
    for (let offset = 0; offset < 1024; offset++) expect(gapped.u8(offset)).toBe(plain[offset]);
    for (const offset of [61, 62, 63, 66, 318, 319]) {
      expect(gapped.u32(offset)).toBe(new DataView(plain.buffer).getUint32(offset, true));
    }
  });

  it('reloads a file image, truncated or whole, byte for byte', () => {
    const { gapped } = mirrored(64, 256, 1024);
    const whole = Uint8Array.from({ length: 900 }, (_, index) => (index * 31 + 7) & 0xff);
    gapped.load(whole);
    expect(Array.from(gapped.slice(0, 900))).toEqual(Array.from(whole));
    const short = whole.subarray(0, 150);
    gapped.load(short);
    expect(Array.from(gapped.slice(0, 150))).toEqual(Array.from(short));
    expect(gapped.slice(150, 400)).toHaveLength(0);
    expect(gapped.capacity).toBe(150);
  });
});

describe('the journal of a Linux machine', () => {
  it('five machines stay under one megabyte of buffers each', () => {
    createDevice('linux-pc', 0, 0);
    const before = process.memoryUsage().arrayBuffers;
    const machines = Array.from({ length: 5 }, () => createDevice('linux-pc', 0, 0));
    const perMachine = (process.memoryUsage().arrayBuffers - before) / machines.length;
    expect(perMachine).toBeLessThan(MEGABYTE);
  });

  it('the journal file read through the VFS keeps its allocated size', async () => {
    const pc = createDevice('linux-pc', 0, 0) as unknown as { executeCommand(line: string): Promise<string> };
    const listing = await pc.executeCommand('sh -c "ls -l /var/log/journal/*/system.journal"');
    const size = Number(listing.trim().split(/\s+/)[4]);
    expect(size).toBeGreaterThanOrEqual(8 * MEGABYTE);
    const counted = await pc.executeCommand('sh -c "wc -c /var/log/journal/*/system.journal"');
    expect(Number(counted.trim().split(/\s+/)[0])).toBe(size);
    const entries = await pc.executeCommand('journalctl --no-pager -n 3');
    expect(entries.trim().split('\n').length).toBeGreaterThanOrEqual(3);
    const verified = await pc.executeCommand('journalctl --verify');
    expect(verified).toContain('PASS');
  });
});
