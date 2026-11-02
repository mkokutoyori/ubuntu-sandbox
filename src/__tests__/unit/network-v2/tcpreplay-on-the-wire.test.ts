/**
 * What tcpreplay does to a SECOND machine and to the clock, which a veth pair inside one host (tcpreplay-oracle.test.ts) cannot show: the frames it reads from a savefile
 * cross a real cable and are processed by the neighbour (an ICMP echo request replayed at PC2 is answered by PC2's stack, so PC1 receives a reply it never asked for), the
 * pauses between packets move the machine clock and the time stamps the neighbour's tap reads (the 3 s that separate the two frames of a capture are 3 s on the far side),
 * a replay with no end (-l 0) stops like the real tool on an interrupt, and the preset file the real tool reads from the directory of its executable (/usr/bin/.tcpreplayrc),
 * which `--save-opts` writes, satisfies and feeds the options (a preset is not a command-line option: it fills `--intf1` and `--topspeed` but conflicts with nothing).
 * Measured before the change (git stash push -- src/network): the command does not exist, the 6 cases answer `command not found`; the WITNESS (the two machines ping each other) passes either way.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { bytesToFileText } from '@/crypto/encoding';
import { encodePcap } from '@/network/capture/pcap/PcapFile';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { decodeEthernetFrame } from '@/network/devices/linux/network/tcpdump/CaptureFrame';

interface Lab {
  pc1: LinuxPC;
  pc2: LinuxPC;
  vfs: VirtualFileSystem;
  received: Array<{ raw: number[]; atMicros: number }>;
  macs: { pc1: string; pc2: string };
}

function checksum(bytes: number[]): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i] << 8) | (bytes[i + 1] ?? 0);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

function macBytes(text: string): number[] {
  return text.split(':').map((part) => parseInt(part, 16));
}

function echoRequest(sourceMac: string, destinationMac: string, sequence: number): Uint8Array {
  const icmp = [8, 0, 0, 0, 0, 1, sequence >> 8, sequence & 0xff, 0x61, 0x62, 0x63, 0x64];
  const icmpSum = checksum(icmp);
  icmp[2] = icmpSum >> 8;
  icmp[3] = icmpSum & 0xff;
  const header = [0x45, 0, 0, 20 + icmp.length, 0, sequence, 0x40, 0, 64, 1, 0, 0, 10, 0, 0, 1, 10, 0, 0, 2];
  const headerSum = checksum(header);
  header[10] = headerSum >> 8;
  header[11] = headerSum & 0xff;
  return Uint8Array.from([...macBytes(destinationMac), ...macBytes(sourceMac), 0x08, 0x00, ...header, ...icmp]);
}

async function lab(): Promise<Lab> {
  EquipmentRegistry.resetInstance();
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 0, 0);
  new Cable('c1').connect(pc1.getPort('eth0')!, pc2.getPort('eth0')!);
  await pc1.executeCommand('sudo ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await pc2.executeCommand('sudo ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  const vfs = (pc1 as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  vfs.writeFile('/usr/bin/tcpreplay', '', 0, 0, 0o755);
  const received: Lab['received'] = [];
  pc1.getPort('eth0')!.attachTap((tapped) => {
    if (tapped.direction !== 'in') return;
    const decoded = decodeEthernetFrame(tapped.frame, tapped.iface, tapped.direction, tapped.at, tapped.atMicros);
    received.push({ raw: decoded.raw, atMicros: decoded.atMicros ?? 0 });
  });
  return {
    pc1, pc2, vfs, received,
    macs: { pc1: pc1.getPort('eth0')!.getMAC().toString(), pc2: pc2.getPort('eth0')!.getMAC().toString() },
  };
}

function savefile(frames: Array<{ seconds: number; micros: number; data: Uint8Array }>): string {
  return bytesToFileText(encodePcap(
    { linkType: 1, snaplen: 65535, nanosecond: false },
    frames.map((frame) => ({ seconds: frame.seconds, subsecond: frame.micros, originalLength: frame.data.length, data: frame.data })),
  ));
}

const isEchoReply = (frame: { raw: number[] }): boolean => frame.raw[12] === 0x08 && frame.raw[13] === 0x00 && frame.raw[23] === 1 && frame.raw[34] === 0;

describe('tcpreplay on a cable between two machines', () => {
  it('WITNESS: the two machines ping each other', async () => {
    const { pc1 } = await lab();
    expect(await pc1.executeCommand('ping -c 1 10.0.0.2')).toContain('1 packets transmitted, 1 received');
  });

  it('a replayed echo request is answered by the neighbour: the frame crossed the cable and was processed', async () => {
    const { pc1, vfs, received, macs } = await lab();
    vfs.writeFile('/tmp/echo.pcap', savefile([{ seconds: 1793610000, micros: 0, data: echoRequest(macs.pc1, macs.pc2, 1) }]), 0, 0, 0o022);
    const text = await pc1.executeCommand('sudo tcpreplay -i eth0 -t /tmp/echo.pcap');
    expect(text).toContain('Actual: 1 packets (46 bytes) sent');
    expect(received.filter(isEchoReply)).toHaveLength(1);
  });

  it('a capture piped to standard input is replayed like a file', async () => {
    const { pc1, vfs, received, macs } = await lab();
    vfs.writeFile('/tmp/echo.pcap', savefile([{ seconds: 1793610000, micros: 0, data: echoRequest(macs.pc1, macs.pc2, 1) }]), 0, 0, 0o022);
    const text = await pc1.executeCommand('cat /tmp/echo.pcap | sudo tcpreplay -i eth0 -t -');
    expect(text).toContain('Actual: 1 packets (46 bytes) sent');
    expect(received.filter(isEchoReply)).toHaveLength(1);
  });

  it('the pauses between packets move the clock, and the neighbour sees the spacing of the capture', async () => {
    const { pc1, vfs, received, macs } = await lab();
    vfs.writeFile('/tmp/two.pcap', savefile([
      { seconds: 1793610000, micros: 0, data: echoRequest(macs.pc1, macs.pc2, 1) },
      { seconds: 1793610003, micros: 0, data: echoRequest(macs.pc1, macs.pc2, 2) },
    ]), 0, 0, 0o022);
    const before = Number(await pc1.executeCommand('date +%s'));
    const text = await pc1.executeCommand('sudo tcpreplay -i eth0 /tmp/two.pcap');
    const after = Number(await pc1.executeCommand('date +%s'));
    expect(text).toMatch(/sent in 3\.00 seconds/);
    expect(after - before).toBeGreaterThanOrEqual(3);
    expect(after - before).toBeLessThanOrEqual(4);
    const replies = received.filter(isEchoReply);
    expect(replies).toHaveLength(2);
    expect(replies[1].atMicros - replies[0].atMicros).toBeGreaterThan(2_990_000);
    expect(replies[1].atMicros - replies[0].atMicros).toBeLessThan(3_010_000);
  });

  it('a replay with no end stops on an interrupt like the real tool, then prints its statistics', async () => {
    const { pc1, vfs, macs } = await lab();
    vfs.writeFile('/tmp/echo.pcap', savefile([{ seconds: 1793610000, micros: 0, data: echoRequest(macs.pc1, macs.pc2, 1) }]), 0, 0, 0o022);
    const text = await pc1.executeCommand('sudo tcpreplay -i eth0 -t -l 0 /tmp/echo.pcap');
    expect(text).toContain(' User interrupt...');
    expect(text).toContain('sendpacket_abort');
    expect(text).toMatch(/Actual: \d+ packets \(\d+ bytes\) sent in/);
    expect(text).toContain('Statistics for network device: eth0');
  });

  it('the preset file fills --intf1 and --topspeed, and conflicts with nothing', async () => {
    const { pc1, vfs, macs } = await lab();
    vfs.writeFile('/tmp/echo.pcap', savefile([{ seconds: 1793610000, micros: 0, data: echoRequest(macs.pc1, macs.pc2, 1) }]), 0, 0, 0o022);
    vfs.writeFile('/usr/bin/.tcpreplayrc', 'intf1 eth0\ntopspeed\n', 0, 0, 0o022);
    const text = await pc1.executeCommand('sudo tcpreplay /tmp/echo.pcap');
    expect(text).toContain('Actual: 1 packets (46 bytes) sent');
    const conflicting = await pc1.executeCommand('sudo tcpreplay -x 2 /tmp/echo.pcap');
    expect(conflicting).toContain('Actual: 1 packets (46 bytes) sent');
  });

  it('--save-opts with no file writes the preset file that the next run reads', async () => {
    const { pc1, vfs, macs } = await lab();
    vfs.writeFile('/tmp/echo.pcap', savefile([{ seconds: 1793610000, micros: 0, data: echoRequest(macs.pc1, macs.pc2, 1) }]), 0, 0, 0o022);
    expect(await pc1.executeCommand('sudo tcpreplay -i eth0 -t --save-opts')).toBe('');
    expect(vfs.readFile('/usr/bin/.tcpreplayrc')).toMatch(/^# {2}tcpreplay \(tcpreplay\) - Replay network traffic stored in pcap files\n# {2}preset\/initialization file\n# {2}.*\n#\nintf1 = {13}eth0\ntopspeed\n$/);
    expect(await pc1.executeCommand('sudo tcpreplay /tmp/echo.pcap')).toContain('Actual: 1 packets (46 bytes) sent');
  });
});
