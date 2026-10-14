/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security, Commands A to C):
 * `crypto ipsec df-bit [clear|set|copy]` and `crypto ipsec fragmentation {before-encryption|
 * after-encryption}`, in global and interface configuration (the interface wins).
 *
 *   df-bit clear   outer DF cleared; the router may fragment the encrypted packet
 *   df-bit set     outer DF set; the router may still fragment the ORIGINAL packet if its DF is clear
 *   df-bit copy    outer DF copied from the original packet (default)
 *   fragmentation before-encryption (default)  a packet predicted to exceed the output MTU once
 *                  encapsulated is fragmented before encryption
 *   fragmentation after-encryption             it is encrypted whole and the outer packet fragmented
 *
 * Lab: ipsecLab (PC1 - R1 == R2 - PC2, IKEv1 PSK, ESP tunnel). The tap on R1's WAN port reads the
 * ESP datagrams actually sent: their size, their outer DF/MF flags and whether the packet inside
 * is a fragment. The pings carry 1450 bytes of data (1478 on the wire), which overflows the 1500
 * MTU once ESP is added; `-M dont` clears the DF bit of the original packet.
 *
 * Measured with src stashed to HEAD: the commands are refused, the SA always copies the DF bit and
 * a too large packet is always fragmented after encryption, so 8 of the 12 cases fall. Four pass
 * either way, each for a named reason: the two witnesses (a small packet is one ESP datagram; a
 * DF-set original gets Fragmentation-needed under copy), "after-encryption" (it is the old
 * behaviour, the refused command changes nothing) and "the interface setting overrides" in its
 * copy-over-clear direction (copy is the old behaviour). The clear-over-copy direction falls,
 * which is why both directions are kept.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { ipsecLab } from './_helpers/ipsecLab';
import type { IPv4Packet } from '@/network/core/types';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const DF = 0b010;
const MF = 0b100;

function innerOf(packet: IPv4Packet): IPv4Packet | undefined {
  return (packet.payload as { innerPacket?: IPv4Packet } | undefined)?.innerPacket;
}

async function sendBig(lab: Awaited<ReturnType<typeof ipsecLab>>, flags = '-M dont'): Promise<string> {
  await lab.pc1.executeCommand('ping -c 1 192.168.2.10');
  lab.wire.length = 0;
  return lab.pc1.executeCommand(`ping -c 1 ${flags} -s 1450 192.168.2.10`);
}

describe('crypto ipsec df-bit and fragmentation', () => {
  it('witness: a small packet crosses the tunnel as one ESP datagram', async () => {
    const lab = await ipsecLab();
    await lab.pc1.executeCommand('ping -c 1 192.168.2.10');
    lab.wire.length = 0;
    expect(await lab.pc1.executeCommand('ping -c 1 -s 100 192.168.2.10')).toContain('1 received');
    expect(lab.wire.length).toBe(1);
  });

  it('default: a DF-clear packet is fragmented BEFORE encryption', async () => {
    const lab = await ipsecLab();
    expect(await sendBig(lab)).toContain('1 received');
    expect(lab.wire.length).toBeGreaterThanOrEqual(2);
    for (const esp of lab.wire) {
      expect(esp.totalLength).toBeLessThanOrEqual(1500);
      expect(esp.fragmentOffset).toBe(0);
      expect(esp.flags & MF).toBe(0);
    }
    const inner = lab.wire.map((esp) => innerOf(esp) as IPv4Packet);
    expect(inner.some((piece) => (piece.flags & MF) !== 0)).toBe(true);
  });

  it('after-encryption: the packet is encrypted whole and the OUTER packet is fragmented', async () => {
    const lab = await ipsecLab(['crypto ipsec fragmentation after-encryption']);
    expect(await sendBig(lab)).toContain('1 received');
    const first = lab.wire[0];
    expect(innerOf(first)?.totalLength).toBe(1478);
    expect(lab.wire.some((piece) => piece.fragmentOffset > 0 || (piece.flags & MF) !== 0)).toBe(true);
  });

  it('df-bit set: every ESP datagram carries DF and the original packet is still fragmented first', async () => {
    const lab = await ipsecLab(['crypto ipsec df-bit set']);
    expect(await sendBig(lab)).toContain('1 received');
    expect(lab.wire.length).toBeGreaterThanOrEqual(2);
    for (const esp of lab.wire) {
      expect(esp.flags & DF).toBe(DF);
      expect(esp.totalLength).toBeLessThanOrEqual(1500);
    }
  });

  it('df-bit set also overrides after-encryption: DF forbids fragmenting the outer packet', async () => {
    const lab = await ipsecLab(['crypto ipsec df-bit set', 'crypto ipsec fragmentation after-encryption']);
    expect(await sendBig(lab)).toContain('1 received');
    for (const esp of lab.wire) {
      expect(esp.flags & DF).toBe(DF);
      expect(esp.fragmentOffset).toBe(0);
    }
  });

  it('df-bit clear with a DF-set original: no Fragmentation-needed, the OUTER packet is fragmented', async () => {
    const lab = await ipsecLab(['crypto ipsec df-bit clear']);
    const out = await sendBig(lab, '-M do');
    expect(out).toContain('1 received');
    expect(out).not.toContain('Frag needed');
    for (const esp of lab.wire) expect(esp.flags & DF).toBe(0);
    expect(lab.wire.some((piece) => piece.fragmentOffset > 0 || (piece.flags & MF) !== 0)).toBe(true);
  });

  it('witness: copy (default) with a DF-set original answers Fragmentation-needed', async () => {
    const lab = await ipsecLab();
    expect(await sendBig(lab, '-M do')).toContain('Frag needed');
    expect(lab.wire.length).toBe(0);
  });

  it('the interface setting overrides the global one', async () => {
    const lab = await ipsecLab([
      'crypto ipsec df-bit clear',
      'interface GigabitEthernet0/1', 'crypto ipsec df-bit copy',
    ]);
    expect(await sendBig(lab, '-M do')).toContain('Frag needed');
  });

  it('the interface setting wins in the other direction too: clear on the interface, copy globally', async () => {
    const lab = await ipsecLab(['interface GigabitEthernet0/1', 'crypto ipsec df-bit clear']);
    const out = await sendBig(lab, '-M do');
    expect(out).toContain('1 received');
    for (const esp of lab.wire) expect(esp.flags & DF).toBe(0);
  });

  it('the settings are rendered in the running-config, the interface ones under their interface', async () => {
    const lab = await ipsecLab([
      'crypto ipsec df-bit clear', 'crypto ipsec fragmentation after-encryption',
      'interface GigabitEthernet0/1', 'crypto ipsec df-bit set', 'crypto ipsec fragmentation before-encryption',
    ]);
    const config = await lab.r1.executeCommand('show running-config');
    expect(config).toMatch(/^crypto ipsec df-bit clear$/m);
    expect(config).toMatch(/^crypto ipsec fragmentation after-encryption$/m);
    expect(config).toMatch(/interface GigabitEthernet0\/1\n[^!]*\n crypto ipsec df-bit set\n/);
    expect(config).toMatch(/ crypto ipsec fragmentation before-encryption\n/);
    expect(config).toMatch(/ crypto map CMAP\n/);
  });

  it('the no forms restore the defaults and leave the configuration clean', async () => {
    const lab = await ipsecLab([
      'crypto ipsec df-bit set', 'crypto ipsec fragmentation after-encryption',
      'no crypto ipsec df-bit', 'no crypto ipsec fragmentation after-encryption',
    ]);
    const config = await lab.r1.executeCommand('show running-config');
    expect(config).not.toContain('crypto ipsec df-bit');
    expect(config).not.toContain('crypto ipsec fragmentation');
    expect(await sendBig(lab)).toContain('1 received');
    expect(innerOf(lab.wire[0])?.totalLength).toBeLessThan(1478);
  });

  it('a value outside the grammar is refused', async () => {
    const lab = await ipsecLab();
    await lab.r1.executeCommand('configure terminal');
    expect(await lab.r1.executeCommand('crypto ipsec df-bit zorglub')).toContain('Invalid input');
    expect(await lab.r1.executeCommand('crypto ipsec fragmentation')).toContain('Incomplete');
  });
});
