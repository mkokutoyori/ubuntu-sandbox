/**
 * --unique-ip rewrites the two IPv4 addresses of every packet at each pass (send_packets.c fast_edit_packet, tcpreplay 4.4.4): the source goes down and the destination up by the
 * iteration (or the other way round when the destination is the lower), with a compensation of one unit when either wraps, so that the 16-bit one's complement sum of the two
 * addresses, and therefore the IP and transport checksums, are left unchanged. A cached (--preload-pcap) packet is edited in place by one unit per pass, and its comparison is made in
 * 64 bits (the iteration is a COUNTER), which a 32-bit port gets wrong as soon as an address is smaller than the iteration.
 * The vectors come from the arithmetic of the real function, copied unchanged from the 4.4.4 source and compiled around fixed Ethernet/IPv4 offsets (scripts/oracle/tcpreplay_fast_edit.c):
 * 13 addresses x 13 addresses x 11 iterations (0 to 5 000 000 000) x cached or not = 3718 cases, every wrap and every carry between the two sides included.
 * The first port fell on 26 of them (cached, iteration of 2^32 or more, source address 0): `src_ip - 1 - iteration` wraps in 32 bits at `src_ip - 1` before the 64-bit subtraction. The function lives in
 * an untracked module on this branch's first commit, so the stash cannot discriminate it; the count above was taken on the first port and the test is the witness that it stays closed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { uniqueAddressEdit } from '@/network/devices/linux/network/tcpreplay/TcpreplayFlows';
import { DLT_EN10MB } from '@/network/devices/linux/network/tcpreplay/TcpreplayLink';

type Vector = [source: number, destination: number, iteration: number, cached: 0 | 1, editedSource: number, editedDestination: number];

const vectors = JSON.parse(readFileSync(new URL('../../support/oracle/tcpreplay-fast-edit-4.4.4.json', import.meta.url), 'utf8')) as Vector[];

function frameWith(source: number, destination: number): Uint8Array {
  const frame = new Uint8Array(60);
  frame[12] = 0x08;
  frame[13] = 0x00;
  frame[14] = 0x45;
  const write = (at: number, value: number) => {
    frame[at] = value >>> 24;
    frame[at + 1] = (value >>> 16) & 0xff;
    frame[at + 2] = (value >>> 8) & 0xff;
    frame[at + 3] = value & 0xff;
  };
  write(26, source);
  write(30, destination);
  return frame;
}

function addressesOf(frame: Uint8Array): [number, number] {
  const read = (at: number) => ((frame[at] << 24) | (frame[at + 1] << 16) | (frame[at + 2] << 8) | frame[at + 3]) >>> 0;
  return [read(26), read(30)];
}

describe('--unique-ip address arithmetic against the real fast_edit_packet', () => {
  it('WITNESS: the grid holds the identity case (iteration 0 on a quiet pair)', () => {
    expect(vectors.some(([source, destination, iteration, cached]) => source === destination && iteration === 0 && cached === 0)).toBe(true);
  });

  it('answers the real arithmetic for all 3718 cases', () => {
    const mismatches: Vector[] = [];
    for (const vector of vectors) {
      const [source, destination, iteration, cached, editedSource, editedDestination] = vector;
      const frame = frameWith(source, destination);
      expect(uniqueAddressEdit(frame, iteration, cached === 1, DLT_EN10MB)).toBe(true);
      const [gotSource, gotDestination] = addressesOf(frame);
      if (gotSource !== editedSource || gotDestination !== editedDestination) mismatches.push(vector);
    }
    expect(mismatches).toEqual([]);
  });

  it('refuses a frame that is not IP, as the real function returns -1', () => {
    const arp = new Uint8Array(60);
    arp[12] = 0x08;
    arp[13] = 0x06;
    expect(uniqueAddressEdit(arp, 1, false, DLT_EN10MB)).toBe(false);
  });
});
